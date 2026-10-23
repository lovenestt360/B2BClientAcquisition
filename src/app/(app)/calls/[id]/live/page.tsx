import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { requireUser } from "@/server/auth/current";
import { getAssistView, suggestedOutcome } from "@/server/voice/assist";
import { softphoneEnv } from "@/server/providers/softphone";
import { ModeBadge, PageHeader } from "@/components/ui";
import { LiveCallAssist } from "@/components/voice/LiveCallAssist";
import { OUTCOMES } from "@/components/outreach/CallCard";

export default async function LiveCallPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;
  const call = await prisma.call.findUnique({ where: { id }, include: { contact: { include: { company: true } } } });
  if (!call || call.mode !== "MANUAL" || !call.contact) notFound();
  const [iphone, softphone] = await Promise.all([
    prisma.providerConfig.findUnique({ where: { key: "iphone_manual_call" } }),
    prisma.providerConfig.findUnique({ where: { key: "sip_softphone" } }),
  ]);
  const started = (call.engineState as { kind?: string } | null)?.kind === "assist";
  const initial = started ? await getAssistView(prisma, id) : null;
  const c = call.contact;
  const name = `${c.firstName} ${c.lastName ?? ""}`.trim();

  return (
    <div className="space-y-4">
      <PageHeader title={`Live call: ${name}`} subtitle="You talk; the AI listens (after you tell the lead) and writes your next line.">
        <ModeBadge mode="MANUAL" />
        <Link className="btn-secondary" href="/calls">Call queue</Link>
      </PageHeader>
      {!started && !["QUEUED", "DIALING"].includes(call.status) ? (
        <p className="muted">This call is already finished. <Link className="underline" href={`/calls/${id}`}>View it</Link>.</p>
      ) : (
        <LiveCallAssist
          callId={id}
          initial={initial}
          lead={{ name, company: c.company?.name ?? null, phone: call.toE164, isSimulated: c.isSimulated }}
          sources={{ speakerphone: !!iphone?.enabled, softphone: !!softphone?.enabled && !!softphoneEnv() }}
          sttEnabled={env().STT_PROVIDER === "http"}
          outcomes={OUTCOMES}
          suggestedOutcome={suggestedOutcome(initial?.stage ?? "opener")}
        />
      )}
    </div>
  );
}
