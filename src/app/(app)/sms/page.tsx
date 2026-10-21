import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/auth/rbac";
import { checkEligibility } from "@/server/compliance/eligibility";
import { getHalt, getSenderProfile } from "@/server/compliance/controls";
import { smsSegments } from "@/server/ai/drafts";
import { ActionForm } from "@/components/ActionForm";
import { DeliveryBadge, Empty, ModeBadge, PageHeader, StatusBadge, fmtDate } from "@/components/ui";
import { SmsHandoff } from "@/components/outreach/SmsHandoff";
import { approveDraftAction, generateDraftsAction, rejectDraftAction } from "@/app/actions/outreach";

export default async function SmsPage() {
  const user = await requireUser();
  const [sender, halt, providers] = await Promise.all([
    getSenderProfile(prisma),
    getHalt(prisma),
    prisma.providerConfig.findMany({ where: { kind: "SMS" }, orderBy: { key: "asc" } }),
  ]);
  const enabledProviders = providers.filter((p) => p.enabled);
  const contacts = await prisma.contact.findMany({
    where: { phoneNumbers: { some: { type: "MOBILE" } } },
    include: { company: { select: { name: true } }, phoneNumbers: { where: { type: "MOBILE" }, take: 1 } },
    orderBy: { updatedAt: "desc" },
    take: 40,
  });
  const elig = await Promise.all(contacts.map((c) => checkEligibility(prisma, { contactId: c.id, channel: "SMS", ignoreContactWindow: true })));
  const drafts = await prisma.messageDraft.findMany({
    where: { channel: "SMS", status: { in: ["PENDING_APPROVAL", "APPROVED", "HANDED_OFF"] } },
    include: { contact: { select: { id: true, firstName: true, lastName: true, isSimulated: true } } },
    orderBy: { createdAt: "asc" },
  });
  const history = await prisma.messageDraft.findMany({
    where: { channel: "SMS", status: { in: ["SENT_CONFIRMED", "SEND_FAILED", "REJECTED", "CANCELLED"] } },
    include: { contact: { select: { id: true, firstName: true, lastName: true } } },
    orderBy: { updatedAt: "desc" },
    take: 20,
  });
  const mode = (key: string) => providers.find((p) => p.key === key)?.mode ?? "MANUAL";
  const pending = drafts.filter((d) => d.status === "PENDING_APPROVAL");
  const ready = drafts.filter((d) => d.status !== "PENDING_APPROVAL");

  return (
    <div className="space-y-6">
      <PageHeader title="SMS" subtitle="AI drafts → your approval → you send from iPhone Messages">
        <ModeBadge mode="MANUAL" />
      </PageHeader>
      {halt.halted && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">Emergency stop is active. Outreach is paused.</p>}
      {!sender.businessName && (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
          Set your business name and opt-out text on the <Link className="underline" href="/compliance">Compliance</Link> page first (POPIA s69(4)).
        </p>
      )}

      <section className="card space-y-3" aria-labelledby="gen">
        <h2 id="gen" className="font-semibold">1. Draft messages</h2>
        {enabledProviders.length === 0 ? (
          <Empty>No SMS provider is enabled. An admin can enable &quot;iPhone Messages (Telkom prepaid)&quot; on the <Link className="underline" href="/providers">Providers</Link> page.</Empty>
        ) : (
          <ActionForm action={generateDraftsAction} submitLabel="Generate drafts for selected">
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="providerKey">Channel</label>
                <select className="input" id="providerKey" name="providerKey">
                  {enabledProviders.map((p) => <option key={p.key} value={p.key}>{p.displayName}</option>)}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="purpose">Purpose</label>
                <select className="input" id="purpose" name="purpose">
                  <option value="marketing">Marketing (needs consent or existing customer)</option>
                  <option value="consent_request">One-time consent request (POPIA s69(2))</option>
                </select>
              </div>
            </div>
            <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto rounded border border-slate-200">
              {contacts.map((c, i) => (
                <li key={c.id} className="flex items-start gap-2 p-2 text-sm">
                  <input type="checkbox" name="contactId" value={c.id} id={`c-${c.id}`} className="mt-1 h-5 w-5" aria-label={`Select ${c.firstName} ${c.lastName ?? ""}`} />
                  <label htmlFor={`c-${c.id}`} className="flex-1">
                    <span className="font-medium">{c.firstName} {c.lastName}</span>{" "}
                    {c.isSimulated && <span className="badge bg-violet-100 text-violet-800">dummy</span>}
                    <span className="block text-xs text-slate-500">{c.company?.name} · {c.phoneNumbers[0]?.e164}</span>
                    {elig[i].eligible ? (
                      <span className="text-xs text-green-700">eligible for marketing ({elig[i].basis?.replace("_", " ")})</span>
                    ) : (
                      <span className="text-xs text-amber-700">{elig[i].reasons[0]}</span>
                    )}
                  </label>
                </li>
              ))}
            </ul>
            <p className="text-xs text-slate-500">Ineligible contacts are skipped automatically. Drafts never send on their own.</p>
          </ActionForm>
        )}
      </section>

      <section aria-labelledby="approve" className="space-y-2">
        <h2 id="approve" className="font-semibold">2. Review &amp; approve ({pending.length})</h2>
        {pending.length === 0 ? <Empty>No drafts waiting for approval.</Empty> : pending.map((d) => {
          const seg = smsSegments(d.body);
          return (
            <div key={d.id} className="card space-y-2" data-testid="pending-draft">
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <Link href={`/sms/${d.contact.id}`} className="font-medium text-brand-700">{d.contact.firstName} {d.contact.lastName}</Link>
                <span className="text-xs text-slate-500">{d.toAddress} · {d.purpose.replace("_", " ")} · by {d.generatedBy}</span>
              </div>
              {can(user.role, "outreach.approve") ? (
                <>
                  <ActionForm action={approveDraftAction} submitLabel="Approve">
                    <input type="hidden" name="draftId" value={d.id} />
                    <textarea className="input font-mono" name="body" defaultValue={d.body} rows={3} aria-label="Message text" />
                    <p className="text-xs text-slate-500">{seg.length} chars · {seg.segments} segment(s) · {seg.encoding}</p>
                  </ActionForm>
                  <form action={rejectDraftAction}><input type="hidden" name="draftId" value={d.id} /><button className="text-xs text-red-700 hover:underline">Reject</button></form>
                </>
              ) : (
                <p className="rounded bg-slate-50 p-2 font-mono text-sm">{d.body}<span className="mt-1 block text-xs text-slate-500">Waiting for a manager to approve.</span></p>
              )}
            </div>
          );
        })}
      </section>

      <section aria-labelledby="send" className="space-y-2">
        <h2 id="send" className="font-semibold">3. Send from your iPhone ({ready.length})</h2>
        {ready.length === 0 ? <Empty>Nothing approved yet.</Empty> : ready.map((d) => (
          <div key={d.id} className="card space-y-2" data-testid="ready-draft">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <Link href={`/sms/${d.contact.id}`} className="font-medium text-brand-700">{d.contact.firstName} {d.contact.lastName}</Link>
              <span className="flex gap-1"><ModeBadge mode={mode(d.providerKey)} /><StatusBadge status={d.status} /></span>
            </div>
            <p className="whitespace-pre-wrap rounded bg-slate-50 p-2 font-mono text-sm">{d.body}</p>
            <SmsHandoff draftId={d.id} body={d.body} status={d.status} simulated={d.contact.isSimulated} />
          </div>
        ))}
      </section>

      <section className="card overflow-x-auto p-0" aria-labelledby="hist">
        <h2 id="hist" className="p-4 pb-0 font-semibold">History</h2>
        <table className="tbl">
          <thead><tr><th>Contact</th><th>Status</th><th>Delivery</th><th className="hidden sm:table-cell">Updated</th></tr></thead>
          <tbody>
            {history.map((d) => (
              <tr key={d.id}>
                <td><Link className="text-brand-700" href={`/sms/${d.contact.id}`}>{d.contact.firstName} {d.contact.lastName}</Link></td>
                <td><StatusBadge status={d.status} /></td>
                <td><DeliveryBadge state={d.deliveryState} /></td>
                <td className="hidden sm:table-cell">{fmtDate(d.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
