"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/server/auth/current";
import { emailChangeInput, passwordChangeInput } from "@/server/auth/account";
import { hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from "@/server/auth/password";
import { SESSION_COOKIE } from "@/server/auth/sessions";
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

export async function changeOwnEmailAction(_p: ActionResult | undefined, form: FormData): Promise<ActionResult> {
  const admin = await requirePermission("users.manage");
  return safe(async () => {
    const input = emailChangeInput.parse(Object.fromEntries(form));
    const user = await prisma.user.findUniqueOrThrow({ where: { id: admin.id } });
    if (!(await verifyPassword(input.currentPassword, user.passwordHash))) throw new AppError("Current password is incorrect");
    if (input.email === user.email) throw new AppError("Enter a different email address");
    if (await prisma.user.findUnique({ where: { email: input.email } })) throw new AppError("Email already in use");
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: admin.id }, data: { email: input.email } });
      await audit(tx, { actorId: admin.id, action: "user.email_change", entityType: "user", entityId: admin.id, metadata: { previousEmail: user.email, newEmail: input.email } });
    });
    revalidatePath("/users");
  }, "Email updated");
}

export async function changeOwnPasswordAction(_p: ActionResult | undefined, form: FormData): Promise<ActionResult> {
  const admin = await requirePermission("users.manage");
  const result = await safe(async () => {
    const input = passwordChangeInput.parse(Object.fromEntries(form));
    const user = await prisma.user.findUniqueOrThrow({ where: { id: admin.id } });
    if (!(await verifyPassword(input.currentPassword, user.passwordHash))) throw new AppError("Current password is incorrect");
    if (await verifyPassword(input.newPassword, user.passwordHash)) throw new AppError("New password must be different from the current password");
    const passwordHash = await hashPassword(input.newPassword);
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: admin.id }, data: { passwordHash } });
      await tx.session.deleteMany({ where: { userId: admin.id } });
      await audit(tx, { actorId: admin.id, action: "user.password_change", entityType: "user", entityId: admin.id });
    });
  });
  if (result.ok) {
    (await cookies()).delete(SESSION_COOKIE);
    redirect("/login");
  }
  return result;
}
