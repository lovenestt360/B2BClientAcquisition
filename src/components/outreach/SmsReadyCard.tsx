import Link from "next/link";
import { ModeBadge, StatusBadge } from "@/components/ui";
import { SmsHandoff } from "./SmsHandoff";

export interface ReadyDraft {
  id: string;
  body: string;
  status: string;
  toAddress: string;
  contact: { id: string; firstName: string; lastName: string | null; isSimulated: boolean };
}

/** An approved SMS ready for the user to send from iPhone Messages. */
export function SmsReadyCard({ draft, mode }: { draft: ReadyDraft; mode: string }) {
  return (
    <div className="card space-y-2" data-testid="ready-draft">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <Link href={`/sms/${draft.contact.id}`} className="font-medium text-brand-700">{draft.contact.firstName} {draft.contact.lastName}</Link>
        <span className="flex gap-1"><ModeBadge mode={mode} /><StatusBadge status={draft.status} /></span>
      </div>
      <p className="whitespace-pre-wrap rounded bg-slate-50 p-2 font-mono text-sm">{draft.body}</p>
      <SmsHandoff draftId={draft.id} body={draft.body} status={draft.status} simulated={draft.contact.isSimulated} />
    </div>
  );
}
