import { prisma } from "@/lib/db";
import { AppError } from "@/server/errors";
import { assistAudio } from "@/server/voice/assist";
import { handle } from "../../../http";

const MAX = 5 * 1024 * 1024;
const SPEAKERS = ["caller", "lead", "auto"] as const;

/** One speech segment from the browser (?speaker=caller|lead|auto). Transcribed, then discarded. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle(async (user) => {
    const speaker = new URL(req.url).searchParams.get("speaker") ?? "auto";
    if (!(SPEAKERS as readonly string[]).includes(speaker)) throw new AppError("speaker must be caller, lead or auto");
    const buf = Buffer.from(await req.arrayBuffer());
    if (!buf.length || buf.length > MAX) throw new AppError("Audio must be between 1 byte and 5 MB");
    return assistAudio(prisma, id, buf, req.headers.get("content-type") ?? "audio/webm", speaker as (typeof SPEAKERS)[number], user);
  });
}
