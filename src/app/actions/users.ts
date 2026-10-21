"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/server/auth/current";
import { hashPassword, MIN_PASSWORD_LENGTH } from "@/server/auth/password";
import { audit } from "@/server/audit";
import { AppError } from "@/server/errors";
import { safe, type ActionResult } from "./util";

const userInput = z.object({
  name: z.string().trim().min(1),
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(["ADMIN", "MANAGER", "OPERATOR", "VIEWER"]),
  password: z.string().min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`),
});

export async function createUserAction(_p: ActionResult | undefined, form: FormData): Promise<ActionResult> {
  const admin = await requirePermission("users.manage");
  return safe(async () => {
    const input = userInput.parse(Object.fromEntries(form));
    if (await prisma.user.findUnique({ where: { email: input.email } })) throw new AppError("Email already in use");
    const u = await prisma.user.create({
      data: { name: input.name, email: input.email, role: input.role, passwordHash: await hashPassword(input.password) },
    });
    await audit(prisma, { actorId: admin.id, action: "user.create", entityType: "user", entityId: u.id, metadata: { role: u.role } });
    revalidatePath("/users");
  }, "User created");
}

export async function toggleUserAction(form: FormData) {
  const admin = await requirePermission("users.manage");
  const id = String(form.get("userId"));
  if (id === admin.id) throw new AppError("You cannot deactivate yourself");
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  await prisma.user.update({ where: { id }, data: { active: !u.active } });
  if (u.active) await prisma.session.deleteMany({ where: { userId: id } });
  await audit(prisma, { actorId: admin.id, action: u.active ? "user.deactivate" : "user.activate", entityType: "user", entityId: id });
  revalidatePath("/users");
}
