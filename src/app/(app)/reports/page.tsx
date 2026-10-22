import { prisma } from "@/lib/db";
import { outreachReport } from "@/server/reports";
import { DeliveryBadge, ModeBadge, PageHeader, Stat } from "@/components/ui";

const pct = (n: number | null) => (n == null ? "—" : `${Math.round(n * 100)}%`);

export default async function ReportsPage() {
  const r = await outreachReport(prisma, 30);
  const maxOutcome = Math.max(1, ...r.callsByOutcome.map((c) => c._count._all));
  return (
    <div className="space-y-6">
      <PageHeader title="Performance" subtitle="Last 30 days. Manual-channel figures come from what you reported." />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="SMS sent (you confirmed)" value={r.smsSent} />
        <Stat label="SMS reply rate" value={pct(r.replyRate)} hint={`${r.replies} SMS replies recorded`} />
        <Stat label="Call connect rate" value={pct(r.callConnectRate)} />
        <Stat label="Meetings from calls" value={r.meetings} />
        <Stat label="Opt-outs" value={r.optOuts} />
        <Stat label="Airtime spend" value={`R${(r.airtimeSpendCents / 100).toFixed(2)}`} hint="estimated + manual entries" />
      </div>
      <section className="card" data-testid="email-report">
        <h2 className="mb-2 font-semibold">Email</h2>
        <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
          <div><p className="text-xs text-slate-500">Sent</p><p className="text-xl font-semibold">{r.email.sent}</p></div>
          <div><p className="text-xs text-slate-500">Reply rate</p><p className="text-xl font-semibold">{pct(r.email.replyRate)}</p><p className="text-xs text-slate-500">{r.email.interested} interested</p></div>
          <div><p className="text-xs text-slate-500">Proven delivered</p><p className="text-xl font-semibold">{r.email.deliveredByEvidence}</p><p className="text-xs text-slate-500">via reply / auto-reply</p></div>
          <div><p className="text-xs text-slate-500">Bounced / failed</p><p className="text-xl font-semibold">{r.email.failed}</p><p className="text-xs text-slate-500">{r.email.unsubscribes} unsubscribed</p></div>
        </div>
        <p className="mt-2 text-xs text-slate-500">
          {r.email.accepted} accepted by the mail server with no further evidence. Server acceptance doesn&apos;t mean it reached the inbox, so it isn&apos;t counted as delivered.
        </p>
      </section>
      <section className="card">
        <h2 className="mb-2 font-semibold">Call outcomes (manual iPhone calls)</h2>
        <div className="space-y-1">
          {r.callsByOutcome.map((c) => (
            <div key={c.outcome} className="flex items-center gap-2 text-sm">
              <span className="w-48 shrink-0 truncate">{c.outcome?.replace(/_/g, " ").toLowerCase()}</span>
              <div className="h-3 flex-1 rounded bg-slate-100"><div className="h-3 rounded bg-brand-600" style={{ width: `${(c._count._all / maxOutcome) * 100}%` }} /></div>
              <span className="w-8 text-right tabular-nums">{c._count._all}</span>
            </div>
          ))}
          {r.callsByOutcome.length === 0 && <p className="muted">No outcomes recorded yet.</p>}
        </div>
      </section>
      <div className="grid gap-4 md:grid-cols-2">
        <section className="card">
          <h2 className="mb-2 font-semibold">SMS delivery evidence</h2>
          <table className="tbl"><thead><tr><th>Provider</th><th>State</th><th>Count</th></tr></thead>
            <tbody>{r.deliveryStates.map((d, i) => <tr key={i}><td className="text-xs">{d.providerKey}</td><td><DeliveryBadge state={d.deliveryState} /></td><td>{d._count._all}</td></tr>)}</tbody>
          </table>
          <p className="mt-2 text-xs text-slate-500">&quot;Delivery unknown&quot; is expected for iPhone SMS: no receipts exist.</p>
        </section>
        <section className="card">
          <h2 className="mb-2 font-semibold">Calls by channel</h2>
          <table className="tbl"><thead><tr><th>Channel</th><th>Provider</th><th>Calls</th></tr></thead>
            <tbody>{r.callsByMode.map((c, i) => <tr key={i}><td><ModeBadge mode={c.mode} /></td><td className="text-xs">{c.providerKey}</td><td>{c._count._all}</td></tr>)}</tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
