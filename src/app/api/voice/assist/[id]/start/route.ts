import { prisma } from "@/lib/db";
import { startAssist } from "@/server/voice/assist";
import { handle } from "../../../http";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle(async (user) => startAssist(prisma, id, await req.json(), user));
}
