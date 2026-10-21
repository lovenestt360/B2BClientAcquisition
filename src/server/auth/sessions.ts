import type { Db } from "@/lib/db";
import { randomToken, sha256 } from "../crypto";
import { verifyPassword } from "./password";
import { audit } from "../audit";

export const SESSION_COOKIE = "sid";
export const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12h

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: import("@prisma/client").Role;
}

// Simple in-process login throttle (per email). For multi-instance deployments
// put a reverse-proxy rate limit in front as well (see docs/DEPLOYMENT.md).
const failures = new Map<string, { count: number; until: number }>();
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;

export function isLocked(email: string, now = Date.now()): boolean {
  const f = failures.get(email);
  return !!f && f.count >= MAX_FAILURES && f.until > now;
}

export async function login(
  db: Db,
  emailInput: string,
  password: string,
  meta: { ip?: string; userAgent?: string } = {},
): Promise<{ token: string; user: SessionUser } | { error: string }> {
  const email = emailInput.trim().toLowerCase();
  if (isLocked(email)) return { error: "Too many attempts. Try again later." };

  const user = await db.user.findUnique({ where: { email } });
  const ok = user && user.active && (await verifyPassword(password, user.passwordHash));
  if (!ok) {
    const f = failures.get(email) ?? { count: 0, until: 0 };
    f.count += 1;
    f.until = Date.now() + LOCK_MS;
    failures.set(email, f);
    await audit(db, {
      action: "auth.login_failed",
      entityType: "user",
      entityId: user?.id,
      metadata: { email },
      ipAddress: meta.ip,
    });
    return { error: "Invalid email or password" };
  }
  failures.delete(email);

  const token = randomToken();
  await db.session.create({
    data: {
      id: sha256(token),
      userId: user.id,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      ipAddress: meta.ip,
      userAgent: meta.userAgent?.slice(0, 300),
    },
  });
  await db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await audit(db, { actorId: user.id, action: "auth.login", entityType: "user", entityId: user.id, ipAddress: meta.ip });
  return { token, user: { id: user.id, email: user.email, name: user.name, role: user.role } };
}

export async function resolveSession(db: Db, token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  const session = await db.session.findUnique({ where: { id: sha256(token) }, include: { user: true } });
  if (!session || session.expiresAt < new Date() || !session.user.active) return null;
  const { id, email, name, role } = session.user;
  return { id, email, name, role };
}

export async function logout(db: Db, token: string | undefined) {
  if (!token) return;
  const s = await db.session.findUnique({ where: { id: sha256(token) } });
  if (!s) return;
  await db.session.delete({ where: { id: s.id } });
  await audit(db, { actorId: s.userId, action: "auth.logout", entityType: "user", entityId: s.userId });
}
