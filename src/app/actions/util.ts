import { ZodError } from "zod";
import { AppError } from "@/server/errors";

export type ActionResult<T = unknown> = { ok: true; data?: T; message?: string } | { ok: false; error: string };

/** Convert expected errors into a form-friendly result; rethrow everything else (incl. redirects). */
export async function safe<T>(fn: () => Promise<T>, message?: string): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn(), message };
  } catch (e) {
    if (e instanceof ZodError) return { ok: false, error: e.issues.map((i) => i.message).join("; ") };
    if (e instanceof AppError) return { ok: false, error: e.message };
    throw e;
  }
}
