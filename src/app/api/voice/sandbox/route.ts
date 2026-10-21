import { prisma } from "@/lib/db";
import { startSandbox } from "@/server/voice/sandbox";
import { handle } from "../http";

export async function POST(req: Request) {
  return handle(async (user) => {
    const body = (await req.json()) as { voiceAgentId: string; contactId?: string };
    return startSandbox(prisma, body, user);
  });
}
