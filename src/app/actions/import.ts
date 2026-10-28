"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/server/auth/current";
import { cancelImport, createImportPreview, deleteImportWithCreatedContacts } from "@/server/import/service";
import { enqueue } from "@/server/jobs";
import { safe, type ActionResult } from "./util";

const MAX_BYTES = 8 * 1024 * 1024;

export async function uploadImportAction(_p: ActionResult | undefined, form: FormData): Promise<ActionResult> {
  const user = await requirePermission("import.run");
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose a CSV or XLSX file" };
  if (file.size > MAX_BYTES) return { ok: false, error: "File is larger than 8 MB" };
  const res = await safe(async () =>
    createImportPreview(prisma, { fileName: file.name, data: Buffer.from(await file.arrayBuffer()), userId: user.id }),
  );
  if (res.ok) redirect(`/import/${res.data!.batchId}`);
  return res;
}

export async function commitImportAction(form: FormData) {
  const user = await requirePermission("import.run");
  const batchId = String(form.get("batchId"));
  // Idempotency key: one commit job per batch, however many times the button is pressed.
  await enqueue(prisma, "import.commit", { batchId, userId: user.id }, `import.commit:${batchId}`).catch(() => undefined);
  revalidatePath(`/import/${batchId}`);
}

export async function cancelImportAction(form: FormData) {
  const user = await requirePermission("import.run");
  const batchId = String(form.get("batchId"));
  await cancelImport(prisma, batchId, user.id);
  revalidatePath(`/import/${batchId}`);
}

export async function researchImportAction(form: FormData) {
  const user = await requirePermission("import.run");
  const batchId = String(form.get("batchId"));
  await enqueue(prisma, "import.enrich", { batchId, userId: user.id }, `import.enrich:${batchId}:${Date.now()}`).catch(() => undefined);
  revalidatePath(`/import/${batchId}`);
}

export async function deleteImportAction(form: FormData) {
  const user = await requirePermission("import.run");
  const batchId = String(form.get("batchId") ?? "");
  const confirmation = String(form.get("confirmation") ?? "");
  await deleteImportWithCreatedContacts(prisma, batchId, confirmation, user.id);
  revalidatePath("/import");
  redirect("/import");
}
