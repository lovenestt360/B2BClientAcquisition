import { prisma } from "@/lib/db";
import { AppError } from "@/server/errors";
import { sandboxAudio } from "@/server/voice/sandbox";
import { handle } from "../../../http";

const MAX = 5 * 1024 * 1024;

/** Receives one utterance recorded by the browser; audio is transcribed and discarded. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle(async (user) => {
    const buf = Buffer.from(await req.arrayBuffer());
    if (!buf.length || buf.length > MAX) throw new AppError("Audio must be between 1 byte and 5 MB");
    return sandboxAudio(prisma, id, buf, req.headers.get("content-type") ?? "audio/webm", user);
  });
}
