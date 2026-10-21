import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { PageHeader, ReplyLabel, fmtDate } from "@/components/ui";

/** Inbound email from an address that matches no contact. */
export default async function InboundEmail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const m = await prisma.emailMessage.findUnique({ where: { id } });
  if (!m || m.direction !== "inbound") notFound();
  return (
    <div className="mx-auto max-w-2xl space-y-3">
      <PageHeader title={m.subject} subtitle={`From ${m.fromAddress} · ${fmtDate(m.occurredAt)}`}><ReplyLabel label={m.classification} /></PageHeader>
      <article className="card whitespace-pre-wrap text-sm">{m.bodyText}</article>
      <p className="text-xs text-slate-500">This sender isn&apos;t a contact. Only add them if they gave you their details and a lawful basis applies.</p>
    </div>
  );
}
