"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { login, logout, SESSION_COOKIE, SESSION_TTL_MS } from "@/server/auth/sessions";

export async function loginAction(_prev: { error?: string } | undefined, form: FormData) {
  const h = await headers();
  const res = await login(prisma, String(form.get("email") ?? ""), String(form.get("password") ?? ""), {
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim(),
    userAgent: h.get("user-agent") ?? undefined,
  });
  if ("error" in res) return { error: res.error };
  (await cookies()).set(SESSION_COOKIE, res.token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env().COOKIE_SECURE,
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
  // Phones open on the work queue; laptops on the dashboard.
  redirect(/iPhone|iPod|Android.+Mobile/.test(h.get("user-agent") ?? "") ? "/today" : "/");
}

export async function logoutAction() {
  const jar = await cookies();
  await logout(prisma, jar.get(SESSION_COOKIE)?.value);
  jar.delete(SESSION_COOKIE);
  redirect("/login");
}
