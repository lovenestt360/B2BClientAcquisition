import Link from "next/link";
import type { Prisma } from "@prisma/client";
import type { CallGuidance } from "@/server/voice/guidance";
import { ActionForm } from "@/components/ActionForm";
import { StageBadge, StatusBadge } from "@/components/ui";
import { DialButton } from "./DialButton";
import { callOutcomeAction } from "@/app/actions/outreach";

export type QueuedCall = Prisma.CallGetPayload<{ include: { contact: { include: { company: true; phoneNumbers: true } } } }>;

export const OUTCOMES = [
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

/** Lead profile, AI talking points, dial button and outcome form for one manual call. */
export function CallCard({ call }: { call: QueuedCall }) {
  const g = call.guidance as unknown as CallGuidance | null;
  const c = call.contact!;
  return (
    <article className="card space-y-3" data-testid="queued-call">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <Link className="text-lg font-semibold text-brand-700" href={`/contacts/${c.id}`}>{c.firstName} {c.lastName}</Link>
          {c.isSimulated && <span className="badge ml-1 bg-violet-100 text-violet-800">dummy</span>}
          <p className="text-sm text-slate-600">{[c.title, c.company?.name, c.company?.industry].filter(Boolean).join(" · ")}</p>
          <p className="font-mono text-sm">{call.toE164}</p>
        </div>
        <div className="flex items-center gap-1"><StageBadge stage={c.stage} /><StatusBadge status={call.status} /></div>
      </header>
      <div className="flex flex-wrap items-start gap-2">
        <Link className="btn-primary" href={`/calls/${call.id}/live`}>🎧 Call with live assist</Link>
        {call.providerKey === "iphone_manual_call" && <DialButton callId={call.id} label={call.status === "DIALING" ? "Dial again (no assist)" : `Call ${c.firstName} (no assist)`} />}
      </div>
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
}
