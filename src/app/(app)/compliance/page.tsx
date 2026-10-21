import { prisma } from "@/lib/db";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/auth/rbac";
import { getHalt, getSenderProfile } from "@/server/compliance/controls";
import { ActionForm, Field } from "@/components/ActionForm";
import { PageHeader, fmtDate } from "@/components/ui";
import { emergencyStopAction, senderProfileAction, suppressionAction } from "@/app/actions/outreach";

export default async function CompliancePage() {
  const user = await requireUser();
  const manage = can(user.role, "compliance.manage");
  const [halt, sender, suppressions, permissions] = await Promise.all([
    getHalt(prisma),
    getSenderProfile(prisma),
    prisma.suppression.findMany({ orderBy: { createdAt: "desc" }, take: 100 }),
    prisma.marketingPermission.findMany({ orderBy: { createdAt: "desc" }, take: 30, include: { contact: { select: { firstName: true, lastName: true } } } }),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader title="Compliance" subtitle="POPIA s69 · CPA s11 & Reg 4 for South Africa; strict opt-in for other countries. Not legal advice." />

      <section className={`card space-y-2 ${halt.halted ? "border-red-300 bg-red-50" : ""}`} aria-labelledby="stop">
        <h2 id="stop" className="font-semibold">Emergency stop</h2>
        {halt.halted ? (
          <>
            <p className="text-sm text-red-800" role="alert">All outreach is halted{halt.reason ? `: ${halt.reason}` : ""} (since {fmtDate(halt.at)}).</p>
            {manage && <form action={emergencyStopAction}><input type="hidden" name="halt" value="false" /><button className="btn-secondary">Resume outreach</button></form>}
          </>
        ) : (
          <form action={emergencyStopAction} className="flex flex-wrap gap-2">
            <input type="hidden" name="halt" value="true" />
            <input className="input max-w-sm" name="reason" placeholder="Reason (optional)" aria-label="Stop reason" />
            <button className="btn-danger">Stop all outreach now</button>
          </form>
        )}
        <p className="text-xs text-slate-500">Stopping cancels every unsent draft and queued call. Any operator can stop; only a manager can resume.</p>
      </section>

      <section className="card" aria-labelledby="sender">
        <h2 id="sender" className="mb-1 font-semibold">Sender identity (POPIA s69(4))</h2>
        <p className="mb-2 text-xs text-slate-500">Every SMS starts with your business name and ends with an opt-out instruction.</p>
        {manage ? (
          <ActionForm action={senderProfileAction} submitLabel="Save">
            <Field label="Business name (max 40)" name="businessName" required defaultValue={sender.businessName} />
            <Field label="Opt-out text" name="optOutText" required defaultValue={sender.optOutText} />
          </ActionForm>
        ) : (
          <p className="text-sm">{sender.businessName || "Not set"} · {sender.optOutText}</p>
        )}
      </section>

      <section className="card space-y-2" aria-labelledby="sup">
        <h2 id="sup" className="font-semibold">Suppression list ({suppressions.length})</h2>
        {manage && (
          <ActionForm action={suppressionAction} submitLabel="Suppress" className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1"><Field label="Email, phone number or domain" name="value" required /></div>
            <div>
              <label className="label" htmlFor="channel">Channel</label>
              <select className="input" id="channel" name="channel"><option value="">All channels</option><option>SMS</option><option>EMAIL</option><option>VOICE_MANUAL</option><option>VOICE_AUTOMATED</option></select>
            </div>
            <div><Field label="Reason" name="reason" defaultValue="manual" /></div>
          </ActionForm>
        )}
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead><tr><th>Identifier</th><th>Channel</th><th>Reason</th><th className="hidden sm:table-cell">Added</th></tr></thead>
            <tbody>{suppressions.map((s) => <tr key={s.id}><td className="font-mono text-xs">{s.email ?? s.e164 ?? s.domain}</td><td>{s.channel ?? "all"}</td><td>{s.reason}</td><td className="hidden sm:table-cell">{fmtDate(s.createdAt)}</td></tr>)}</tbody>
          </table>
        </div>
      </section>

      <section className="card overflow-x-auto" aria-labelledby="perm">
        <h2 id="perm" className="mb-2 font-semibold">Recent consent records</h2>
        <table className="tbl">
          <thead><tr><th>Contact</th><th>Channel</th><th>Status</th><th className="hidden md:table-cell">Evidence</th><th className="hidden sm:table-cell">Captured</th></tr></thead>
          <tbody>{permissions.map((p) => <tr key={p.id}><td>{p.contact.firstName} {p.contact.lastName}</td><td>{p.channel}</td><td>{p.status.toLowerCase()}{p.basis ? ` (${p.basis.toLowerCase()})` : ""}</td><td className="hidden max-w-xs truncate md:table-cell">{p.evidence}</td><td className="hidden sm:table-cell">{fmtDate(p.capturedAt)}</td></tr>)}</tbody>
        </table>
      </section>
    </div>
  );
}
