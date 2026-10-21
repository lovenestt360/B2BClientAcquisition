import Link from "next/link";
import { prisma } from "@/lib/db";
import { listInbox } from "@/server/inbox";
import { Empty, PageHeader, ReplyLabel, fmtDate } from "@/components/ui";
import { setHandledAction } from "@/app/actions/email";

const LABELS = ["interested", "question", "not_interested", "unsubscribe", "out_of_office", "bounce", "other", "sms"];

export default async function InboxPage({ searchParams }: { searchParams: Promise<{ status?: string; label?: string }> }) {
  const sp = await searchParams;
  const status = sp.status === "all" ? "all" : "open";
  const items = await listInbox(prisma, { status, label: sp.label });
  const q = (o: Record<string, string | undefined>) => "?" + new URLSearchParams(Object.entries({ status, label: sp.label, ...o }).filter(([, v]) => v) as [string, string][]).toString();

  return (
    <div className="space-y-4">
      <PageHeader title="Inbox" subtitle="Email replies synced from your mailbox and SMS replies you entered, in one place" />
      <div className="flex flex-wrap gap-2 text-sm">
        <Link className={`badge ${status === "open" ? "bg-slate-800 text-white" : "bg-slate-100"}`} href={q({ status: "open" })}>Open</Link>
        <Link className={`badge ${status === "all" ? "bg-slate-800 text-white" : "bg-slate-100"}`} href={q({ status: "all" })}>All</Link>
        <span className="mx-1 text-slate-300">|</span>
        <Link className={`badge ${!sp.label ? "bg-slate-800 text-white" : "bg-slate-100"}`} href={q({ label: undefined })}>any</Link>
        {LABELS.map((l) => (
          <Link key={l} className={`badge ${sp.label === l ? "bg-slate-800 text-white" : "bg-slate-100"}`} href={q({ label: l })}>{l.replace(/_/g, " ")}</Link>
        ))}
      </div>
      {items.length === 0 ? <Empty>{status === "open" ? "Inbox zero. Nothing needs attention." : "No replies yet."}</Empty> : (
        <ul className="space-y-2">
          {items.map((i) => (
            <li key={`${i.kind}-${i.id}`} className={`card space-y-1 ${i.handled ? "opacity-60" : ""}`} data-testid="inbox-item">
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="flex items-center gap-2">
                  <span aria-hidden>{i.kind === "email" ? "✉️" : "💬"}</span>
                  <Link className="font-medium text-brand-700" href={i.threadHref}>{i.contact ? `${i.contact.firstName} ${i.contact.lastName ?? ""}` : i.from}</Link>
                  <ReplyLabel label={i.label} />
                </span>
                <span className="text-xs text-slate-500">{fmtDate(i.occurredAt)}</span>
              </div>
              {i.subject && <p className="text-sm font-medium">{i.subject}</p>}
              <p className="text-sm text-slate-700">{i.preview}</p>
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>{i.kind === "email" ? "Email" : "SMS"} · {i.evidence}</span>
                <form action={setHandledAction}>
                  <input type="hidden" name="kind" value={i.kind} />
                  <input type="hidden" name="id" value={i.id} />
                  <input type="hidden" name="handled" value={i.handled ? "false" : "true"} />
                  <button className="btn-secondary min-h-8 px-2 py-1 text-xs">{i.handled ? "Reopen" : "Done"}</button>
                </form>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
