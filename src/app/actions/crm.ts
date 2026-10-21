"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { PipelineStage } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/server/auth/current";
import { createCompany, createContact, updateContactStage } from "@/server/crm/contacts";
import { safe, type ActionResult } from "./util";

export async function createContactAction(_p: ActionResult | undefined, form: FormData): Promise<ActionResult> {
  const user = await requirePermission("crm.write");
  const res = await safe(() => createContact(prisma, Object.fromEntries(form), user.id));
  if (res.ok) redirect(`/contacts/${(res.data as { id: string }).id}`);
  return res;
}

export async function createCompanyAction(_p: ActionResult | undefined, form: FormData): Promise<ActionResult> {
  const user = await requirePermission("crm.write");
  const res = await safe(() => createCompany(prisma, Object.fromEntries(form), user.id));
  if (res.ok) redirect(`/companies/${(res.data as { id: string }).id}`);
  return res;
}

export async function changeStageAction(form: FormData) {
  const user = await requirePermission("crm.write");
  const id = String(form.get("contactId"));
  await updateContactStage(prisma, id, String(form.get("stage")) as PipelineStage, user.id);
  revalidatePath(`/contacts/${id}`);
}
