import Link from "next/link";
import { prisma } from "@/lib/db";
import { ActionForm } from "@/components/ActionForm";
import { Empty, ModeBadge, PageHeader, StageBadge, StatusBadge, fmtDate } from "@/components/ui";
import { DialButton } from "@/components/outreach/DialButton";
import { callOutcomeAction, queueCallAction } from "@/app/actions/outreach";
import type { CallGuidance } from "@/server/voice/guidance";

const OUTCOMES = [
  ["CONNECTED_INTERESTED", "Connected – interested"],
  ["CONNECTED_CALLBACK", "Connected – call back"],
  ["MEETING_BOOKED", "Meeting booked"],
  ["CONNECTED_NOT_INTERESTED", "Connected – not interested"],
  ["VOICEMAIL", "Voicemail"],
  ["NO_ANSWER", "No answer"],
  ["BUSY", "Busy"],
  ["WRONG_NUMBER", "Wrong number"],
  ["OPT_OUT_REQUESTED", "Asked not to be contacted"],
  ["OTHER", "Other"],
  ["DID_NOT_CALL", "I didn't call (back to queue)"],
];

export default async function CallsPage() {
  const provider = await prisma.providerConfig.findUnique({ where: { key: "iphone_manual_call" } });
  const queue = await prisma.call.findMany({
    where: { mode: "MANUAL", status: { in: ["QUEUED", "DIALING"] } },
    include: { contact: { include: { company: true, phoneNumbers: true } } },
    orderBy: { createdAt: "asc" },
  });
  const recent = await prisma.call.findMany({
    where: { status: { notIn: ["QUEUED", "DIALING"] } },
    include: { contact: { select: { id: true, firstName: true, lastName: true } } },
    orderBy: { updatedAt: "desc" },
    take: 20,
  });
  const contacts = await prisma.contact.findMany({
    where: { phoneNumbers: { some: {} } },
    select: { id: true, firstName: true, lastName: true, isSimulated: true, company: { select: { name: true } } },
    orderBy: { firstName: "asc" },
    take: 300,
  });

  return (
    <div className="space-y-6">
      <PageHeader title="Calls" subtitle="You dial from your iPhone. The platform shows guidance and records the outcome you report.">
        <ModeBadge mode="MANUAL" />
        <Link className="btn-secondary" href="/voice">AI voice sandbox</Link>
      </PageHeader>
      {!provider?.enabled && (
        <Empty>Manual iPhone calling is disabled. An admin can enable it on the <Link className="underline" href="/providers">Providers</Link> page.</Empty>
      )}
      {provider?.enabled && (
        <section className="card max-w-xl">
          <ActionForm action={queueCallAction} submitLabel="Add to call queue" className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1">
              <label className="label" htmlFor="contactId">Contact</label>
              <select className="input" id="contactId" name="contactId" required>
                {contacts.map((c) => <option key={c.id} value={c.id}>{c.firstName} {c.lastName}{c.company ? ` – ${c.company.name}` : ""}{c.isSimulated ? " (dummy)" : ""}</option>)}
              </select>
            </div>
          </ActionForm>
        </section>
      )}

      <section className="space-y-3" aria-labelledby="queue">
        <h2 id="queue" className="font-semibold">Call queue ({queue.length})</h2>
        {queue.length === 0 && <Empty>The queue is empty.</Empty>}
        {queue.map((call) => {
          const g = call.guidance as unknown as CallGuidance | null;
          const c = call.contact!;
          return (
            <article key={call.id} className="card space-y-3" data-testid="queued-call">
              <header className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <Link className="text-lg font-semibold text-brand-700" href={`/contacts/${c.id}`}>{c.firstName} {c.lastName}</Link>
                  {c.isSimulated && <span className="badge ml-1 bg-violet-100 text-violet-800">dummy</span>}
                  <p className="text-sm text-slate-600">{[c.title, c.company?.name, c.company?.industry].filter(Boolean).join(" · ")}</p>
                  <p className="font-mono text-sm">{call.toE164}</p>
                </div>
                <div className="flex items-center gap-1"><StageBadge stage={c.stage} /><StatusBadge status={call.status} /></div>
              </header>
              <DialButton callId={call.id} label={call.status === "DIALING" ? "Dial again" : `Call ${c.firstName}`} />
              {g && (
                <details className="rounded-lg bg-slate-50 p-3 text-sm" open>
                  <summary className="cursor-pointer font-medium">Talking points <span className="text-xs text-slate-500">({g.generatedBy})</span></summary>
                  <p className="mt-2"><strong>Opener:</strong> {g.opener}</p>
                  <ul className="mt-1 list-disc pl-5">{g.talkingPoints.map((t, i) => <li key={i}>{t}</li>)}</ul>
                  <p className="mt-2 font-medium">Questions</p>
                  <ul className="list-disc pl-5">{g.questions.map((t, i) => <li key={i}>{t}</li>)}</ul>
                  {g.objections.length > 0 && (
                    <>
                      <p className="mt-2 font-medium">Objections</p>
                      <ul className="list-disc pl-5">{g.objections.map((o, i) => <li key={i}><em>{o.objection}</em>: {o.response}</li>)}</ul>
                    </>
                  )}
                  <p className="mt-2"><strong>Close:</strong> {g.close}</p>
                  <ul className="mt-2 list-disc pl-5 text-xs text-slate-600">{g.complianceNotes.map((t, i) => <li key={i}>{t}</li>)}</ul>
                </details>
              )}
              {c.notes && <p className="rounded bg-yellow-50 p-2 text-sm">{c.notes}</p>}
              {call.status === "DIALING" && (
                <ActionForm action={callOutcomeAction} submitLabel="Save outcome" className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
                  <input type="hidden" name="callId" value={call.id} />
                  <p className="text-xs text-amber-900">Report what happened. The platform could not hear the call, so this outcome comes only from you.</p>
                  <select className="input" name="outcome" aria-label="Outcome" required>
                    {OUTCOMES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                  <input className="input" type="number" step="0.5" min="0" name="durationMin" placeholder="Duration (minutes, optional)" aria-label="Duration in minutes" />
                  <textarea className="input" name="notes" rows={2} placeholder="Notes" aria-label="Notes" />
                </ActionForm>
              )}
            </article>
          );
        })}
      </section>

      <section className="card overflow-x-auto p-0">
        <h2 className="p-4 pb-0 font-semibold">Recent calls</h2>
        <table className="tbl">
          <thead><tr><th>Contact</th><th>Channel</th><th>Outcome</th><th className="hidden sm:table-cell">When</th></tr></thead>
          <tbody>
            {recent.map((c) => (
              <tr key={c.id}>
                <td><Link className="text-brand-700" href={`/calls/${c.id}`}>{c.contact ? `${c.contact.firstName} ${c.contact.lastName ?? ""}` : "Sandbox caller"}</Link></td>
                <td><ModeBadge mode={c.mode} /></td>
                <td>{c.outcome?.replace(/_/g, " ").toLowerCase() ?? c.status.toLowerCase()}</td>
                <td className="hidden sm:table-cell">{fmtDate(c.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
