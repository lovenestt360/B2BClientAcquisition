"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/server/auth/current";
import { savePlaybook } from "@/server/sales/playbook";
import { saveAvailability } from "@/server/sales/availability";
import { safe, type ActionResult } from "./util";

export async function savePlaybookAction(_p: ActionResult | undefined, form: FormData): Promise<ActionResult> {
  const user = await requirePermission("outreach.approve");
  const res = await safe(() => savePlaybook(prisma, Object.fromEntries(form), user.id), "Playbook saved");
  revalidatePath("/playbook");
  return res;
}

export async function saveAvailabilityAction(_p: ActionResult | undefined, form: FormData): Promise<ActionResult> {
  const user = await requirePermission("outreach.approve");
  const raw = { ...Object.fromEntries(form), days: form.getAll("days").map(String), skipPublicHolidays: form.get("skipPublicHolidays") === "on" };
  const res = await safe(async () => {
    try {
      return await saveAvailability(prisma, raw, user.id);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("End hour")) {
        const { AppError } = await import("@/server/errors");
        throw new AppError(e.message);
      }
      throw e;
    }
  }, "Availability saved");
  revalidatePath("/playbook");
  return res;
}
