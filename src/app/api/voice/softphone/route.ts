import { prisma } from "@/lib/db";
import { AppError } from "@/server/errors";
import { getProvider } from "@/server/providers/registry";
import { softphoneEnv } from "@/server/providers/softphone";
import { handle } from "../http";

/** SIP registration details for the browser softphone. Only for signed-in callers, only when enabled. */
export async function GET() {
  return handle(async () => {
    await getProvider(prisma, "sip_softphone");
    const cfg = softphoneEnv();
    if (!cfg) throw new AppError("Softphone is not configured: set SIP_WSS_URL, SIP_URI and SIP_PASSWORD", "not_configured", 501);
    return { wssUrl: cfg.wssUrl, uri: cfg.uri, password: cfg.password, displayName: cfg.displayName };
  });
}
