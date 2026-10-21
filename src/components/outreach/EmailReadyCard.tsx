import { ActionForm } from "@/components/ActionForm";
import { sendEmailAction } from "@/app/actions/email";

export interface ReadyEmail {
  id: string;
  subject: string | null;
  toAddress: string;
  lastError: string | null;
  contact: { firstName: string; lastName: string | null };
  emailAccount: { isSimulated: boolean } | null;
}

/** Approved email: one tap sends it through your mailbox. */
export function EmailReadyCard({ draft }: { draft: ReadyEmail }) {
  return (
    <div className="card space-y-2" data-testid="ready-email">
      <div className="text-sm">
        <span className="font-medium">{draft.contact.firstName} {draft.contact.lastName}</span>{" "}
        <span className="text-xs text-slate-500">{draft.toAddress}</span>
      </div>
      <p className="text-sm">{draft.subject}</p>
      {draft.lastError && <p className="text-xs text-red-700">Last attempt: {draft.lastError}</p>}
      <ActionForm action={sendEmailAction} submitLabel={draft.emailAccount?.isSimulated ? "Send (simulated)" : "Send now"} className="space-y-1">
        <input type="hidden" name="draftId" value={draft.id} />
      </ActionForm>
    </div>
  );
}
