import Link from "next/link";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/auth/rbac";
import { checkEligibility } from "@/server/compliance/eligibility";
import { getHalt, getSenderProfile } from "@/server/compliance/controls";
import { sentToday } from "@/server/email/accounts";
import { now } from "@/server/clock";
import { startOfLocalDay } from "@/server/today";
import { ActionForm } from "@/components/ActionForm";
import { DeliveryBadge, Empty, ModeBadge, PageHeader, fmtDate } from "@/components/ui";
import { approveEmailAction, generateEmailDraftsAction, rejectEmailAction, sendEmailAction, simulateReplyAction, syncNowAction } from "@/app/actions/email";

export default async function EmailPage() {
  const user = await requireUser();
  const [sender, halt, accounts] = await Promise.all([getSenderProfile(prisma), getHalt(prisma), prisma.emailAccount.findMany({ orderBy: [{ isSimulated: "asc" }, { label: "asc" }] })]);
  const day = startOfLocalDay(now());
  const sent = await Promise.all(accounts.map((a) => sentToday(prisma, a.id, day)));
  const enabled = accounts.filter((a) => a.enabled);
  const contacts = await prisma.contact.findMany({
    where: { email: { not: null } },
    include: { company: { select: { name: true } } },
    orderBy: { updatedAt: "desc" },
    take: 40,
  });
  const elig = await Promise.all(contacts.map((c) => checkEligibility(prisma, { contactId: c.id, channel: "EMAIL", ignoreContactWindow: true })));
  const drafts = await prisma.messageDraft.findMany({
    where: { channel: "EMAIL", status: { in: ["PENDING_APPROVAL", "APPROVED", "HANDED_OFF"] } },
    include: { contact: { select: { id: true, firstName: true, lastName: true, isSimulated: true } }, emailAccount: { select: { fromAddress: true, isSimulated: true } } },
    orderBy: { createdAt: "asc" },
  });
  const sentMsgs = await prisma.emailMessage.findMany({
    where: { direction: "outbound" },
    include: { contact: { select: { id: true, firstName: true, lastName: true, isSimulated: true } }, account: { select: { isSimulated: true } }, _count: { select: { children: true } } },
    orderBy: { occurredAt: "desc" },
    take: 25,
  });
  const pending = drafts.filter((d) => d.status === "PENDING_APPROVAL");
  const ready = drafts.filter((d) => d.status !== "PENDING_APPROVAL");
  const sim = env().SIMULATION_MODE;

  return (
    <div className="space-y-6">
      <PageHeader title="Email" subtitle="AI drafts → approval → you click Send → your own mailbox sends it">
        {can(user.role, "providers.manage") && <Link className="btn-secondary" href="/email/accounts">Mailboxes</Link>}
        <Link className="btn-secondary" href="/inbox">Inbox</Link>
      </PageHeader>
      {halt.halted && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">Emergency stop is active. Sending is blocked.</p>}

      <section className="grid gap-3 md:grid-cols-2" aria-label="Mailboxes">
        {accounts.length === 0 && <Empty>No mailbox yet. An admin can add your Hostinger mailbox under <Link className="underline" href="/email/accounts">Mailboxes</Link>.</Empty>}
        {accounts.map((a, i) => (
          <div key={a.id} className="card space-y-1 text-sm" data-testid="mailbox">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">{a.label}</span>
              <span className="flex gap-1">
                <ModeBadge mode={a.isSimulated ? "SIMULATED" : "MANUAL"} />
                <span className={`badge ${a.enabled ? "bg-green-100 text-green-800" : "bg-slate-200 text-slate-700"}`}>{a.enabled ? "enabled" : "disabled"}</span>
              </span>
            </div>
            <p className="font-mono text-xs">{a.fromName} &lt;{a.fromAddress}&gt;</p>
            <p className="text-xs text-slate-500">Sent today: {sent[i]} / {a.dailyLimit}{a.isSimulated ? " · simulated: nothing leaves the server" : ` · last inbox sync: ${a.lastSyncAt ? fmtDate(a.lastSyncAt) : "never"}`}</p>
            {a.lastSyncError && <p className="text-xs text-red-700">Sync error: {a.lastSyncError}</p>}
            {!a.isSimulated && a.enabled && (
              <form action={syncNowAction}><input type="hidden" name="id" value={a.id} /><button className="text-xs text-brand-700 hover:underline">Check inbox now</button></form>
            )}
          </div>
        ))}
      </section>

      <section className="card space-y-3" aria-labelledby="e-gen">
        <h2 id="e-gen" className="font-semibold">1. Draft emails</h2>
        {!sender.businessName && <p className="text-sm text-amber-800">Set your business name on the <Link className="underline" href="/compliance">Compliance</Link> page first.</p>}
        {enabled.length === 0 ? <Empty>No enabled mailbox.</Empty> : (
          <ActionForm action={generateEmailDraftsAction} submitLabel="Generate email drafts">
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="accountId">From mailbox</label>
                <select className="input" id="accountId" name="accountId">{enabled.map((a) => <option key={a.id} value={a.id}>{a.label} ({a.fromAddress})</option>)}</select>
              </div>
              <div>
                <label className="label" htmlFor="e-purpose">Purpose</label>
                <select className="input" id="e-purpose" name="purpose">
                  <option value="marketing">Marketing (needs consent or existing customer)</option>
                  <option value="consent_request">One-time consent request (POPIA s69(2))</option>
                </select>
              </div>
            </div>
            <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto rounded border border-slate-200">
              {contacts.map((c, i) => (
                <li key={c.id} className="flex items-start gap-2 p-2 text-sm">
                  <input type="checkbox" name="contactId" value={c.id} id={`e-${c.id}`} className="mt-1 h-5 w-5" aria-label={`Select ${c.firstName} ${c.lastName ?? ""}`} />
                  <label htmlFor={`e-${c.id}`} className="min-w-0 flex-1">
                    <span className="font-medium">{c.firstName} {c.lastName}</span> {c.isSimulated && <span className="badge bg-violet-100 text-violet-800">dummy</span>}
                    <span className="block truncate text-xs text-slate-500">{c.company?.name} · {c.email}</span>
                    {elig[i].eligible ? <span className="text-xs text-green-700">eligible ({elig[i].basis?.replace("_", " ")})</span> : <span className="text-xs text-amber-700">{elig[i].reasons[0]}</span>}
                  </label>
                </li>
              ))}
            </ul>
          </ActionForm>
        )}
      </section>

      <section className="space-y-2" aria-labelledby="e-approve">
        <h2 id="e-approve" className="font-semibold">2. Review &amp; approve ({pending.length})</h2>
        {pending.length === 0 ? <Empty>No email drafts waiting.</Empty> : pending.map((d) => (
          <div key={d.id} className="card space-y-2" data-testid="pending-email">
            <div className="flex flex-wrap justify-between gap-2 text-sm">
              <Link className="font-medium text-brand-700" href={`/email/${d.contact.id}`}>{d.contact.firstName} {d.contact.lastName}</Link>
              <span className="text-xs text-slate-500">{d.toAddress} · from {d.emailAccount?.fromAddress} · {d.generatedBy}</span>
            </div>
            {can(user.role, "outreach.approve") ? (
              <>
                <ActionForm action={approveEmailAction} submitLabel="Approve">
                  <input type="hidden" name="draftId" value={d.id} />
                  <input className="input" name="subject" defaultValue={d.subject ?? ""} aria-label="Subject" />
                  <textarea className="input font-mono" name="body" defaultValue={d.body} rows={9} aria-label="Email body" />
                </ActionForm>
                <form action={rejectEmailAction}><input type="hidden" name="draftId" value={d.id} /><button className="text-xs text-red-700 hover:underline">Reject</button></form>
              </>
            ) : (
              <div className="rounded bg-slate-50 p-2 text-sm"><p className="font-medium">{d.subject}</p><p className="whitespace-pre-wrap font-mono">{d.body}</p><p className="mt-1 text-xs text-slate-500">Waiting for a manager to approve.</p></div>
            )}
          </div>
        ))}
      </section>

      <section className="space-y-2" aria-labelledby="e-send">
        <h2 id="e-send" className="font-semibold">3. Send ({ready.length})</h2>
        {ready.length === 0 ? <Empty>Nothing approved yet.</Empty> : ready.map((d) => (
          <div key={d.id} className="card space-y-2" data-testid="ready-email">
            <div className="flex flex-wrap justify-between gap-2 text-sm">
              <span><span className="font-medium">{d.contact.firstName} {d.contact.lastName}</span> <span className="text-xs text-slate-500">{d.toAddress}</span></span>
              <DeliveryBadge state={d.deliveryState} channel="email" />
            </div>
            <p className="text-sm font-medium">{d.subject}</p>
            <p className="max-h-32 overflow-hidden whitespace-pre-wrap rounded bg-slate-50 p-2 font-mono text-xs">{d.body}</p>
            {d.lastError && <p className="text-xs text-red-700">Last attempt: {d.lastError}</p>}
            {d.status === "APPROVED" ? (
              <ActionForm action={sendEmailAction} submitLabel={d.emailAccount?.isSimulated ? "Send (simulated)" : "Send now"} className="space-y-1">
                <input type="hidden" name="draftId" value={d.id} />
              </ActionForm>
            ) : (
              <p className="text-xs text-amber-800">Outcome unknown: the mail server may or may not have taken it. It won&apos;t be resent automatically. Check your Sent folder.</p>
            )}
          </div>
        ))}
      </section>

      <section className="card overflow-x-auto p-0" aria-labelledby="e-sent">
        <h2 id="e-sent" className="p-4 pb-0 font-semibold">Sent</h2>
        <table className="tbl">
          <thead><tr><th>To</th><th className="hidden md:table-cell">Subject</th><th>Delivery</th><th className="hidden sm:table-cell">Sent</th>{sim && <th>Simulate</th>}</tr></thead>
          <tbody>
            {sentMsgs.map((m) => (
              <tr key={m.id}>
                <td>{m.contact ? <Link className="text-brand-700" href={`/email/${m.contact.id}`}>{m.contact.firstName} {m.contact.lastName}</Link> : m.toAddress}</td>
                <td className="hidden max-w-xs truncate md:table-cell">{m.subject}</td>
                <td><DeliveryBadge state={m.deliveryState} channel="email" evidence={m.deliveryEvidence} /></td>
                <td className="hidden whitespace-nowrap sm:table-cell">{fmtDate(m.occurredAt)}</td>
                {sim && (
                  <td>
                    {m.account.isSimulated && m.contact?.isSimulated && (
                      <form action={simulateReplyAction} className="flex gap-1">
                        <input type="hidden" name="messageId" value={m.id} />
                        <select name="kind" className="rounded border border-slate-300 text-xs" aria-label="Simulated reply type">
                          <option value="interested">reply: interested</option>
                          <option value="question">reply: question</option>
                          <option value="not_interested">reply: not interested</option>
                          <option value="unsubscribe">reply: unsubscribe</option>
                          <option value="out_of_office">auto-reply</option>
                          <option value="bounce">bounce</option>
                        </select>
                        <button className="text-xs text-brand-700">Go</button>
                      </form>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
