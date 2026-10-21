import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { ModeBadge, PageHeader, fmtDate } from "@/components/ui";

export default async function CallDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const call = await prisma.call.findUnique({
    where: { id },
    include: { contact: true, events: { orderBy: { occurredAt: "asc" } }, transcripts: { orderBy: { seq: "asc" } }, voiceAgent: true },
  });
  if (!call) notFound();
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader title={call.contact ? `Call with ${call.contact.firstName} ${call.contact.lastName ?? ""}` : "Sandbox conversation"} subtitle={`${call.providerKey} · ${call.status.toLowerCase()}`}>
        <ModeBadge mode={call.mode} />
      </PageHeader>
      <section className="card text-sm">
        <dl className="grid grid-cols-3 gap-y-1">
          <dt className="text-slate-500">Outcome</dt><dd className="col-span-2">{call.outcome?.replace(/_/g, " ").toLowerCase() ?? "—"}</dd>
          <dt className="text-slate-500">Duration</dt><dd className="col-span-2">{call.durationSec ? `${Math.round(call.durationSec / 60)} min (user-entered)` : "—"}</dd>
          <dt className="text-slate-500">Est. cost</dt><dd className="col-span-2">{call.costCents != null ? `R${(call.costCents / 100).toFixed(2)} (estimate)` : "—"}</dd>
          <dt className="text-slate-500">Notes</dt><dd className="col-span-2 whitespace-pre-wrap">{call.notes ?? "—"}</dd>
        </dl>
        {call.mode === "MANUAL" && <p className="mt-2 text-xs text-slate-500">Manual iPhone call: no audio or transcript is available to the platform.</p>}
      </section>
      {call.transcripts.length > 0 && (
        <section className="card space-y-2" aria-label="Transcript">
          <h2 className="font-semibold">Transcript</h2>
          {call.transcripts.map((t) => (
            <p key={t.id} className={`text-sm ${t.speaker === "system" ? "text-xs italic text-slate-500" : ""}`}>
              <strong className="capitalize">{t.speaker === "agent" ? "AI agent" : t.speaker}:</strong> {t.text}
              {t.interrupted && <span className="badge ml-1 bg-amber-100 text-amber-800">interrupted</span>}
            </p>
          ))}
        </section>
      )}
      <section className="card text-sm">
        <h2 className="mb-2 font-semibold">Events</h2>
        <ul className="space-y-1">
          {call.events.map((e) => <li key={e.id} className="flex justify-between"><span>{e.type.replace(/_/g, " ")} <span className="text-xs text-slate-400">({e.evidence})</span></span><span className="muted">{fmtDate(e.occurredAt)}</span></li>)}
        </ul>
      </section>
    </div>
  );
}
