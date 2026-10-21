import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import type { Role } from "@prisma/client";
import { prisma } from "@/lib/db";
import { SESSION_COOKIE, resolveSession, type SessionUser } from "./sessions";
import { assertCan, atLeast, type Permission } from "./rbac";
import { ForbiddenError } from "../errors";

export async function currentUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  return resolveSession(prisma, jar.get(SESSION_COOKIE)?.value);
}

/** For pages: redirect to /login when signed out. */
export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) redirect("/login");
  return user;
}

/** For server actions: throw if signed out or lacking a permission. */
export async function requirePermission(permission: Permission): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) throw new ForbiddenError("Not signed in");
  assertCan(user.role, permission);
  return user;
}

export async function requireRole(min: Role): Promise<SessionUser> {
  const user = await currentUser();
  if (!user || !atLeast(user.role, min)) throw new ForbiddenError();
  return user;
}

export async function clientIp(): Promise<string | undefined> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined;
}
