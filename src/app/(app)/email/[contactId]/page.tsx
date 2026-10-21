import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { DeliveryBadge, PageHeader, ReplyLabel, fmtDate } from "@/components/ui";

export default async function EmailThread({ params }: { params: Promise<{ contactId: string }> }) {
  const { contactId } = await params;
  const contact = await prisma.contact.findUnique({ where: { id: contactId } });
  if (!contact) notFound();
  const msgs = await prisma.emailMessage.findMany({ where: { contactId }, orderBy: { occurredAt: "asc" } });
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader title={`${contact.firstName} ${contact.lastName ?? ""}`} subtitle={contact.email ?? ""}>
        <Link href={`/contacts/${contact.id}`} className="btn-secondary">Profile</Link>
      </PageHeader>
      {msgs.length === 0 && <p className="muted">No emails yet.</p>}
      {msgs.map((m) => (
        <article key={m.id} className={`card space-y-1 ${m.direction === "inbound" ? "border-l-4 border-l-brand-600" : ""}`} data-testid="thread-message">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
            <span>{m.direction === "inbound" ? `From ${m.fromAddress}` : `To ${m.toAddress}`} · {fmtDate(m.occurredAt)}</span>
            {m.direction === "outbound" ? <DeliveryBadge state={m.deliveryState} channel="email" evidence={m.deliveryEvidence} /> : <ReplyLabel label={m.classification} />}
          </div>
          <p className="font-medium">{m.subject}</p>
          <p className="whitespace-pre-wrap text-sm">{m.bodyText}</p>
          {m.bounceCode && <p className="text-xs text-red-700">Bounce {m.bounceType} ({m.bounceCode})</p>}
        </article>
      ))}
      <p className="text-xs text-slate-500">Reply from your own mail app (Hostinger webmail or iPhone Mail). Replies are synced here automatically.</p>
    </div>
  );
}
