import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { ActionForm } from "@/components/ActionForm";
import { PageHeader, fmtDate } from "@/components/ui";
import { manualReplyAction } from "@/app/actions/outreach";

const LABEL: Record<string, string> = {
  DRAFT_CREATED: "Draft created",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  OPENED_IN_NATIVE_APP: "Opened in iPhone Messages",
  COPIED_TO_CLIPBOARD: "Copied",
  USER_CONFIRMED_SENT: "You confirmed sending (delivery unknown)",
  USER_REPORTED_FAILED: "You reported a failure",
  PROVIDER_ACCEPTED: "Provider accepted",
  PROVIDER_DELIVERY_REPORT: "Delivery report",
  PROVIDER_FAILED: "Provider failed",
  INBOUND_REPLY_MANUAL: "Reply (entered manually)",
  INBOUND_REPLY_PROVIDER: "Reply",
  OPT_OUT_RECORDED: "Opt-out recorded",
};

export default async function SmsConversation({ params }: { params: Promise<{ contactId: string }> }) {
  const { contactId } = await params;
  const contact = await prisma.contact.findUnique({ where: { id: contactId }, include: { phoneNumbers: true } });
  if (!contact) notFound();
  const events = await prisma.smsEvent.findMany({ where: { contactId }, orderBy: { occurredAt: "asc" } });
  const bubbles = events.filter((e) => e.type === "USER_CONFIRMED_SENT" || e.type === "USER_REPORTED_FAILED" || e.type === "PROVIDER_ACCEPTED" || e.direction === "inbound");
  const timeline = events.filter((e) => !bubbles.includes(e));

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader title={`${contact.firstName} ${contact.lastName ?? ""}`} subtitle={contact.phoneNumbers.map((p) => p.e164).join(", ")}>
        <Link href={`/contacts/${contact.id}`} className="btn-secondary">Profile</Link>
      </PageHeader>
      <section className="card space-y-2" aria-label="Conversation">
        {bubbles.length === 0 && <p className="muted">No messages yet.</p>}
        {bubbles.map((e) => (
          <div key={e.id} className={`flex ${e.direction === "inbound" ? "justify-start" : "justify-end"}`}>
            <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${e.direction === "inbound" ? "bg-slate-100" : e.type === "USER_REPORTED_FAILED" ? "bg-red-100" : "bg-brand-600 text-white"}`}>
              <p className="whitespace-pre-wrap">{e.body}</p>
              <p className={`mt-1 text-[10px] ${e.direction === "inbound" ? "text-slate-500" : "text-white/80"}`}>
                {fmtDate(e.occurredAt)} · {LABEL[e.type]} · evidence: {e.evidence.replace("_", " ")}
              </p>
            </div>
          </div>
        ))}
      </section>
      <section className="card">
        <h2 className="mb-1 font-semibold">Record a reply from your iPhone</h2>
        <p className="mb-2 text-xs text-slate-500">The platform can&apos;t read your iPhone&apos;s messages. Paste replies here. &quot;STOP&quot; replies are suppressed automatically.</p>
        <ActionForm action={manualReplyAction} submitLabel="Save reply">
          <input type="hidden" name="contactId" value={contact.id} />
          <textarea className="input" name="body" rows={2} required aria-label="Reply text" />
          <div>
            <label className="label" htmlFor="receivedAt">Received at (optional)</label>
            <input className="input" type="datetime-local" id="receivedAt" name="receivedAt" />
          </div>
        </ActionForm>
      </section>
      <section className="card text-sm">
        <h2 className="mb-2 font-semibold">Activity</h2>
        <ul className="space-y-1">
          {timeline.map((e) => <li key={e.id} className="flex justify-between gap-2"><span>{LABEL[e.type]}</span><span className="muted">{fmtDate(e.occurredAt)}</span></li>)}
        </ul>
      </section>
    </div>
  );
}
