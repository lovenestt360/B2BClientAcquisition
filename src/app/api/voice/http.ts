import { ZodError } from "zod";
import { AppError } from "@/server/errors";
import { requirePermission } from "@/server/auth/current";

export async function handle(fn: (user: Awaited<ReturnType<typeof requirePermission>>) => Promise<unknown>) {
  try {
    const user = await requirePermission("outreach.execute");
    return Response.json(await fn(user));
  } catch (e) {
    if (e instanceof AppError) return Response.json({ error: e.message }, { status: e.status });
    if (e instanceof ZodError) return Response.json({ error: e.issues[0]?.message }, { status: 400 });
    console.error(e);
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
}
