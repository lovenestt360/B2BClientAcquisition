import { prisma } from "@/lib/db";
import { can } from "@/server/auth/rbac";
import { requireUser } from "@/server/auth/current";
import { getLaunch, getOutreachSettings, LAUNCH_CONFIRMATION, resolveMode } from "@/server/outreach/config";
import { nextBatchAtOrAfter } from "@/server/outreach/schedule";
import { outreachReconciliation } from "@/server/outreach/report";
import { stepLabel } from "@/server/outreach/sequence";
import { now } from "@/server/clock";
import { ActionForm, Field } from "@/components/ActionForm";
import { Empty, PageHeader, StatusBadge, fmtDate } from "@/components/ui";
import {
  approveLeadAction,
  approveSendAction,
  approveStepAction,
  enrollAction,
  holdLeadAction,
  launchAction,
  reconcileAction,
  regenerateSendAction,
  rejectSendAction,
  runBatchAction,
  saveSequenceSettingsAction,
  setCampaignStatusAction,
  syncConfigAction,
} from "@/app/actions/sequences";

const STATE_STYLE: Record<string, string> = {
  ACTIVE: "bg-green-100 text-green-800",
  PENDING_APPROVAL: "bg-amber-100 text-amber-800",
  HOLD: "bg-orange-100 text-orange-800",
  RESEARCH_REQUIRED: "bg-violet-100 text-violet-800",
  STOPPED: "bg-slate-200 text-slate-700",
  COMPLETED: "bg-blue-100 text-blue-800",
};

export default async function OutreachPage() {
  const user = await requireUser();
  const isAdmin = user.role === "ADMIN";
  const canApprove = can(user.role, "outreach.approve");
  const [settings, launch, mode, campaigns] = await Promise.all([
    getOutreachSettings(prisma),
    getLaunch(prisma),
    resolveMode(prisma),
    prisma.campaign.findMany({ where: { key: { not: null } }, orderBy: { key: "asc" }, include: { steps: { orderBy: { step: "asc" } } } }),
  ]);

  if (!campaigns.length) {
    return (
      <div className="max-w-3xl space-y-4">
        <PageHeader title="Email sequences" subtitle="SA-CON and SA-PM five-step sequences. Nothing is configured yet." />
        <section className="card space-y-2 text-sm">
          <p>Load <code>config/klyron-sa-outreach.json</code>: campaigns, sender, Maputo schedule, caps, approved capabilities and banned claims. Wait days stay unapproved and the Launch Command stays at Stop.</p>
          {isAdmin ? <ActionForm action={syncConfigAction} submitLabel="Load outreach config"><span /></ActionForm> : <p className="text-slate-500">An admin must load it.</p>}
        </section>
      </div>
    );
  }

  const [members, queue, unknown, report, accounts, candidates] = await Promise.all([
    prisma.campaignMember.findMany({ where: { campaign: { key: { not: null } } }, include: { contact: { include: { company: true } }, campaign: true }, orderBy: [{ state: "asc" }, { addedAt: "asc" }], take: 300 }),
    prisma.outreachSend.findMany({ where: { status: { in: ["AWAITING_APPROVAL", "HELD", "RESEARCH_REQUIRED", "APPROVED"] } }, include: { contact: { include: { company: true } }, campaign: true }, orderBy: [{ status: "asc" }, { createdAt: "asc" }], take: 50 }),
    prisma.outreachSend.findMany({ where: { status: { in: ["UNKNOWN", "SENDING"] } }, include: { contact: true, campaign: true } }),
    outreachReconciliation(prisma),
    prisma.emailAccount.findMany({ where: { isSimulated: false }, orderBy: { createdAt: "asc" } }),
    prisma.contact.findMany({ where: { country: "ZA", email: { not: null }, campaignMembers: { none: { campaign: { key: { not: null } } } } }, include: { company: true }, orderBy: { createdAt: "desc" }, take: 200 }),
  ]);
  const next = nextBatchAtOrAfter(now(), settings, true);

  return (
    <div className="space-y-4">
      <PageHeader title="Email sequences" subtitle="Five independent meeting requests per lead, written from the lead's own research. Every step needs human approval." />

      {/* ── Status ── */}
      <section className="card space-y-2 text-sm" data-testid="sequence-status">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`badge ${mode.mode === "live" ? "bg-red-100 text-red-800" : "bg-violet-100 text-violet-800"}`}>{mode.mode === "live" ? "LIVE SENDING" : "DRY RUN: nothing is sent"}</span>
          <span className={`badge ${launch.command === "START" ? "bg-red-100 text-red-800" : "bg-slate-200 text-slate-700"}`}>Launch Command: {launch.command === "START" ? "Start" : "Stop"}</span>
          <span className="text-slate-500">Next batch: {next ? fmtDate(next) : "none scheduled"} ({settings.timezone}) · caps {settings.hourlyCap}/hour, {settings.dailyCap}/day</span>
        </div>
        {mode.blockers.length > 0 && (
          <details>
            <summary className="cursor-pointer text-brand-700">Why it is a dry run ({mode.blockers.length})</summary>
            <ul className="ml-5 list-disc text-slate-600">{mode.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
          </details>
        )}
        <div className="flex flex-wrap items-start gap-3">
          {canApprove && (
            <ActionForm action={runBatchAction} submitLabel="Run batch now" className="flex items-center gap-2">
              <label className="flex items-center gap-1"><input type="checkbox" name="dryRun" defaultChecked className="h-4 w-4" /> force dry run</label>
            </ActionForm>
          )}
          {isAdmin && launch.command === "START" && (
            <ActionForm action={launchAction} submitLabel="Set Launch to Stop"><input type="hidden" name="command" value="STOP" /></ActionForm>
          )}
        </div>
        {isAdmin && launch.command === "STOP" && (
          <details>
            <summary className="cursor-pointer text-red-700">Start live outreach…</summary>
            <div className="mt-2 space-y-2 rounded-md border border-red-200 bg-red-50 p-3">
              <p>Start only after technical and legal sign-off. Live sending also needs <code>OUTREACH_LIVE_SEND=true</code>, <code>ALLOW_AUTOMATED_OUTREACH=true</code>, <code>SIMULATION_MODE=false</code>, the <em>email_sequences</em> provider enabled with an authorisation reference, and a tested mailbox.</p>
              <ActionForm action={launchAction} submitLabel="Set Launch to Start">
                <input type="hidden" name="command" value="START" />
                <Field label={`Type "${LAUNCH_CONFIRMATION}"`} name="confirmation" required />
                <Field label="Note (approval reference)" name="note" />
              </ActionForm>
            </div>
          </details>
        )}
      </section>

      {/* ── Reconciliation ── */}
      <section className="card overflow-x-auto">
        <h2 className="mb-2 font-semibold">Reconciliation</h2>
        <table className="tbl text-xs">
          <thead>
            <tr>{["Campaign", "Enrolled", "Imported", "Verified", "Researched", "Permissioned", "Approved", "Queued", "Sent (SMTP accepted)", "Unknown", "Failed", "Replied", "Booked", "Opted out", "Hard bounce", "Suppressed", "Dry-run sends"].map((h) => <th key={h}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {report.rows.map((r) => (
              <tr key={r.campaign}>
                <td className="font-medium">{r.campaign}</td>
                {[r.enrolled, r.imported, r.verified, r.researched, r.permissioned, r.approved, r.queued, r.sent, r.unknown, r.failed, r.replied, r.booked, r.optedOut, r.hardBounced, r.suppressed, r.dryRunSends].map((v, i) => <td key={i}>{v}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-1 text-xs text-slate-500">Sent counts SMTP acceptance by Hostinger only, never inbox delivery. Dry-run rehearsals are counted separately.</p>
        {(Object.keys(report.holds).length > 0 || Object.keys(report.sendHolds).length > 0) && (
          <div className="mt-2 flex flex-wrap gap-1 text-xs">
            {Object.entries({ ...report.holds }).map(([k, v]) => <span key={`m${k}`} className="badge bg-orange-100 text-orange-800">lead: {k} × {v}</span>)}
            {Object.entries(report.sendHolds).map(([k, v]) => <span key={`s${k}`} className="badge bg-amber-100 text-amber-800">email: {k} × {v}</span>)}
          </div>
        )}
      </section>

      {/* ── Unknown outcomes ── */}
      {unknown.length > 0 && (
        <section className="card space-y-2 border-red-200 text-sm">
          <h2 className="font-semibold text-red-700">Unconfirmed sends ({unknown.length})</h2>
          <p className="text-slate-600">The mail server may or may not have taken these. They are never resent. Check the mailbox&apos;s Sent folder, then record what you found.</p>
          {unknown.map((u) => (
            <ActionForm key={u.id} action={reconcileAction} submitLabel="Record outcome" className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="id" value={u.id} />
              <span>{u.contact.email} · {u.campaign.key} {stepLabel(u.step)} · {u.status}</span>
              <select name="outcome" className="input w-auto"><option value="accepted">It was sent</option><option value="failed">It was not sent</option></select>
              <input name="evidence" className="input w-64" placeholder="Evidence, e.g. found in Sent at 10:02" required />
            </ActionForm>
          ))}
        </section>
      )}

      {/* ── Approval queue ── */}
      <section className="space-y-2">
        <h2 className="font-semibold">Emails for review ({queue.length})</h2>
        {!queue.length && <Empty>No emails waiting. Approved leads get their next step drafted when it is due.</Empty>}
        {queue.map((q) => {
          const v = q.validation as { reasons?: string[]; warnings?: string[]; wordCount?: number } | null;
          const g = q.generation as { output?: { chosenCommercialExposure?: string; supportingEvidenceIds?: string[] } } | null;
          return (
            <article key={q.id} className="card space-y-2 text-sm" data-testid="sequence-email">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{q.contact.firstName} {q.contact.lastName} · {q.contact.company?.name}</span>
                <span className="badge bg-slate-100">{q.campaign.key} {stepLabel(q.step)}</span>
                <StatusBadge status={q.status} />
                {q.dryRun && <span className="badge bg-violet-100 text-violet-800">dry run</span>}
                <span className="text-xs text-slate-500">angle: {g?.output?.chosenCommercialExposure ?? "?"} · evidence: {g?.output?.supportingEvidenceIds?.length ?? 0} · {v?.wordCount ?? "?"} words · {q.generatedBy}</span>
              </div>
              {!!v?.reasons?.length && <ul className="ml-5 list-disc text-xs text-red-700">{v.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
              {!!v?.warnings?.length && <ul className="ml-5 list-disc text-xs text-amber-700">{v.warnings.map((r) => <li key={r}>{r}</li>)}</ul>}
              {q.status === "APPROVED" ? (
                <div className="rounded-md bg-slate-50 p-2"><p className="font-medium">{q.subject}</p><pre className="whitespace-pre-wrap font-sans">{q.body}</pre><p className="mt-1 text-xs text-green-700">Approved: goes out in the next batch it is due for.</p></div>
              ) : q.subject !== "-" ? (
                canApprove && (
                  <ActionForm action={approveSendAction} submitLabel="Approve" className="space-y-2">
                    <input type="hidden" name="id" value={q.id} />
                    <input name="subject" className="input" defaultValue={q.subject ?? ""} aria-label="Subject" />
                    <textarea name="body" className="input min-h-40" defaultValue={q.body ?? ""} aria-label="Body" />
                    <p className="text-xs text-slate-500">Signature and opt-out line are added on sending. Edits are checked again against the lead&apos;s evidence.</p>
                  </ActionForm>
                )
              ) : (
                <p className="text-violet-700">Not written: research is too thin. Add sourced facts and need evidence, then regenerate.</p>
              )}
              <div className="flex flex-wrap gap-2">
                <form action={regenerateSendAction}><input type="hidden" name="id" value={q.id} /><button className="btn-secondary">Regenerate</button></form>
                {canApprove && <form action={rejectSendAction}><input type="hidden" name="id" value={q.id} /><button className="btn-secondary">Reject</button></form>}
              </div>
            </article>
          );
        })}
      </section>

      {/* ── Recipients ── */}
      <section className="card overflow-x-auto">
        <h2 className="mb-2 font-semibold">Recipients ({members.length})</h2>
        {!members.length ? (
          <Empty>No leads enrolled yet.</Empty>
        ) : (
          <table className="tbl text-xs">
            <thead><tr><th>Lead</th><th>Campaign</th><th>State</th><th>Last confirmed</th><th>Next due</th><th>Reason</th><th /></tr></thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id} data-testid="sequence-member">
                  <td>{m.contact.firstName} {m.contact.lastName}<div className="text-slate-500">{m.contact.title} · {m.contact.company?.name}</div></td>
                  <td>{m.campaign.key}</td>
                  <td><span className={`badge ${STATE_STYLE[m.state] ?? "bg-slate-100"}`}>{m.state.replace(/_/g, " ").toLowerCase()}</span></td>
                  <td>{m.lastStep ? `${stepLabel(m.lastStep)} · ${fmtDate(m.lastConfirmedSendAt)}` : "-"}</td>
                  <td>{m.nextDueAt ? fmtDate(m.nextDueAt) : "-"}</td>
                  <td className="max-w-56 break-words">{m.stopReason ?? m.holdReason ?? ""}</td>
                  <td className="whitespace-nowrap">
                    {canApprove && ["PENDING_APPROVAL", "HOLD", "RESEARCH_REQUIRED"].includes(m.state) && (
                      <form action={approveLeadAction} className="inline"><input type="hidden" name="id" value={m.id} /><button className="btn-secondary">{m.state === "PENDING_APPROVAL" ? "Final approval" : "Release"}</button></form>
                    )}
                    {canApprove && m.state === "ACTIVE" && (
                      <form action={holdLeadAction} className="inline"><input type="hidden" name="id" value={m.id} /><input type="hidden" name="reason" value="held from the sequences page" /><button className="btn-secondary">Hold</button></form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {candidates.length > 0 && (
          <details className="mt-3">
            <summary className="cursor-pointer text-sm text-brand-700">Add South African leads ({candidates.length} not enrolled)</summary>
            <ActionForm action={enrollAction} submitLabel="Add to campaign" className="mt-2 space-y-2 text-sm">
              <select name="campaign" className="input w-auto">{campaigns.map((c) => <option key={c.id} value={c.key!}>{c.key}: {c.name}</option>)}</select>
              <div className="max-h-64 overflow-y-auto rounded-md border p-2">
                {candidates.map((c) => (
                  <label key={c.id} className="flex items-center gap-2 py-0.5"><input type="checkbox" name="contactId" value={c.id} className="h-4 w-4" /> {c.firstName} {c.lastName} · {c.title ?? "no title"} · {c.company?.name ?? "no company"}</label>
                ))}
              </div>
            </ActionForm>
          </details>
        )}
      </section>

      {/* ── Campaigns & step timing ── */}
      <section className="grid gap-3 md:grid-cols-2">
        {campaigns.map((c) => (
          <div key={c.id} className="card space-y-2 text-sm">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-semibold">{c.key}: {c.name}</h2>
              <span className="flex items-center gap-2">
                <StatusBadge status={c.status} />
                {canApprove && (
                  <form action={setCampaignStatusAction}><input type="hidden" name="id" value={c.id} /><input type="hidden" name="status" value={c.status === "ACTIVE" ? "PAUSED" : "ACTIVE"} /><button className="btn-secondary">{c.status === "ACTIVE" ? "Pause" : "Activate"}</button></form>
                )}
              </span>
            </div>
            <p className="text-xs text-slate-500">{c.icpDescription}</p>
            <p className="text-xs">Days after the previous confirmed send. A step with no approved wait is held.</p>
            {c.steps.map((s) => (
              <div key={s.id} className="flex flex-wrap items-center gap-2">
                <span className="w-10 font-mono">{stepLabel(s.step)}</span>
                {s.step === 1 ? (
                  <span className="text-slate-500">first touch after final approval</span>
                ) : canApprove ? (
                  <ActionForm action={approveStepAction} submitLabel={s.approved ? "Update" : "Approve"} className="flex items-center gap-2">
                    <input type="hidden" name="id" value={s.id} />
                    <input name="waitDays" type="number" min="1" max="90" className="input w-20" defaultValue={s.waitDays ?? ""} aria-label={`${c.key} ${stepLabel(s.step)} wait days`} required />
                    <span className={s.approved ? "text-green-700" : "text-amber-700"}>{s.approved ? `approved: ${s.waitDays} days` : "not approved (held)"}</span>
                  </ActionForm>
                ) : (
                  <span>{s.approved ? `${s.waitDays} days` : "not approved (held)"}</span>
                )}
              </div>
            ))}
          </div>
        ))}
      </section>

      {/* ── Settings ── */}
      {isAdmin && (
        <section className="card space-y-2 text-sm">
          <h2 className="font-semibold">Sender, links and caps</h2>
          <p className="text-xs text-slate-500">
            Sender: {settings.senderName} · signature “{settings.signature.replace("\n", " / ")}” · {settings.timezone}, {settings.batchHours.map((h) => `${h}:00`).join(", ")} on weekdays · the rest lives in <code>config/klyron-sa-outreach.json</code>.
          </p>
          <ActionForm action={saveSequenceSettingsAction} submitLabel="Save">
            <div>
              <label className="label" htmlFor="emailAccountId">Sending mailbox (Hostinger)</label>
              <select id="emailAccountId" name="emailAccountId" className="input" defaultValue={settings.emailAccountId ?? ""}>
                <option value="">None selected</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.fromName} &lt;{a.fromAddress}&gt; {a.enabled ? "" : "(disabled)"}</option>)}
              </select>
            </div>
            <Field label="Approved booking URL (blank = reply-based invitation)" name="bookingUrl" defaultValue={settings.bookingUrl ?? ""} placeholder="https://…" />
            <div>
              <label className="label" htmlFor="approvedLinkDomains">Approved link domains (one per line)</label>
              <textarea id="approvedLinkDomains" name="approvedLinkDomains" className="input" defaultValue={settings.approvedLinkDomains.join("\n")} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Max sends per hour (both campaigns)" name="hourlyCap" type="number" defaultValue={String(settings.hourlyCap)} />
              <Field label="Max sends per day (both campaigns)" name="dailyCap" type="number" defaultValue={String(settings.dailyCap)} />
            </div>
          </ActionForm>
          <ActionForm action={syncConfigAction} submitLabel="Reload config file"><span className="text-xs text-slate-500">Keeps approvals, recipients, sends and suppressions.</span></ActionForm>
        </section>
      )}
    </div>
  );
}
