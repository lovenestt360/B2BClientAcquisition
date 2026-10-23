import { prisma } from "@/lib/db";
import { assistEvent, getAssistView } from "@/server/voice/assist";
import { handle } from "../../http";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle(async () => getAssistView(prisma, id));
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle(async (user) => assistEvent(prisma, id, await req.json(), user));
}
