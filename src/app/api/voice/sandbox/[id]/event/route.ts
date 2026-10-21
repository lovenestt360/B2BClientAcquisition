import { prisma } from "@/lib/db";
import { sandboxEvent } from "@/server/voice/sandbox";
import { handle } from "../../../http";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle(async (user) => sandboxEvent(prisma, id, await req.json(), user));
}
