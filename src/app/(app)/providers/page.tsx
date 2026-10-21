import { prisma } from "@/lib/db";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/auth/rbac";
import { instantiate, toRuntime } from "@/server/providers/registry";
import { automationBlockers } from "@/server/providers/gate";
import { airtimeSummary } from "@/server/providers/airtime";
import { ActionForm, Field } from "@/components/ActionForm";
import { ModeBadge, PageHeader, fmtDate } from "@/components/ui";
import { airtimeAction, lineAction, providerAction } from "@/app/actions/outreach";

const rand = (c: number | null | undefined) => (c == null ? "—" : `R${(c / 100).toFixed(2)}`);
const yes = (b: boolean) => (b ? "yes" : "no");

export default async function ProvidersPage() {
  const user = await requireUser();
  const admin = can(user.role, "providers.manage");
  const [providers, lines] = await Promise.all([
    prisma.providerConfig.findMany({ orderBy: [{ mode: "asc" }, { key: "asc" }] }),
    prisma.carrierLine.findMany(),
  ]);
  const summaries = await Promise.all(lines.map((l) => airtimeSummary(prisma, l.id)));

  return (
    <div className="space-y-6">
      <PageHeader title="Providers" subtitle="Channels, what each can and cannot do, and the line they bill to" />

      {lines.map((line, i) => {
        const s = summaries[i];
        return (
          <section key={line.id} className="card space-y-3" aria-labelledby={`line-${line.id}`}>
            <h2 id={`line-${line.id}`} className="font-semibold">{line.operator}: {line.plan} {line.simType === "esim" ? "eSIM" : "SIM"} on {line.device}</h2>
            <p className="text-xs text-slate-500">
              No SIM provisioning data is stored: no eSIM QR or activation codes, ICCID or PUK. The line is used only through the native iPhone apps.
            </p>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <div><p className="text-xs text-slate-500">Top-ups recorded</p><p className="font-semibold">{rand(s.topupsCents)}</p></div>
              <div><p className="text-xs text-slate-500">Estimated spend</p><p className="font-semibold">{rand(s.estimatedSpendCents)}</p></div>
              <div><p className="text-xs text-slate-500">Last balance check</p><p className="font-semibold">{s.lastBalance ? `${rand(s.lastBalance.cents)}` : "—"}</p><p className="text-xs text-slate-400">{s.lastBalance ? fmtDate(s.lastBalance.at) : ""}</p></div>
              <div><p className="text-xs text-slate-500">Projected balance</p><p className="font-semibold">{rand(s.projectedBalanceCents)}</p><p className="text-xs text-slate-400">estimate</p></div>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              {admin && (
                <ActionForm action={lineAction} submitLabel="Save line settings">
                  <input type="hidden" name="lineId" value={line.id} />
                  <Field label="This line's number (optional)" name="ownNumberE164" defaultValue={line.ownNumberE164 ?? ""} placeholder="+27…" />
                  <Field label="Test number for dummy leads (e.g. your second phone)" name="testNumberE164" defaultValue={line.testNumberE164 ?? ""} placeholder="+27…" />
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="SMS rate estimate (R / segment)" name="smsRate" type="number" defaultValue={line.smsRateCents != null ? String(line.smsRateCents / 100) : ""} />
                    <Field label="Call rate estimate (R / min)" name="callRate" type="number" defaultValue={line.callRatePerMinCents != null ? String(line.callRatePerMinCents / 100) : ""} />
                  </div>
                  <p className="text-xs text-slate-500">Take rates from your Telkom prepaid plan. Spend is only ever an estimate.</p>
                </ActionForm>
              )}
              <ActionForm action={airtimeAction} submitLabel="Record airtime">
                <input type="hidden" name="lineId" value={line.id} />
                <div>
                  <label className="label" htmlFor="kind">Entry</label>
                  <select className="input" id="kind" name="kind">
                    <option value="topup">Top-up / recharge</option>
                    <option value="balance_check">Balance check (amount shown on phone)</option>
                    <option value="adjustment">Adjustment (negative = spend)</option>
                  </select>
                </div>
                <Field label="Amount (R)" name="amountRand" type="number" required />
                <Field label="Note" name="note" />
              </ActionForm>
            </div>
            <details>
              <summary className="cursor-pointer text-sm text-brand-700">Ledger ({s.entries.length})</summary>
              <table className="tbl mt-2">
                <thead><tr><th>When</th><th>Kind</th><th>Amount</th><th>Note</th></tr></thead>
                <tbody>{s.entries.map((e) => <tr key={e.id}><td>{fmtDate(e.createdAt)}</td><td>{e.kind}{e.estimated ? " (est.)" : ""}</td><td>{rand(e.amountCents)}</td><td>{e.note}</td></tr>)}</tbody>
              </table>
            </details>
          </section>
        );
      })}

      <section className="space-y-3">
        {providers.map((p) => {
          const caps = instantiate(p).capabilities;
          const blockers = p.mode === "AUTOMATED" ? automationBlockers(toRuntime(p)) : [];
          return (
            <article key={p.key} className="card space-y-2" data-testid={`provider-${p.key}`}>
              <header className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-semibold">{p.displayName} <code className="text-xs text-slate-500">{p.key}</code></h3>
                <span className="flex gap-1">
                  <ModeBadge mode={p.mode} />
                  <span className={`badge ${p.enabled ? "bg-green-100 text-green-800" : "bg-slate-200 text-slate-700"}`}>{p.enabled ? "enabled" : "disabled"}</span>
                </span>
              </header>
              <dl className="grid grid-cols-2 gap-x-4 text-xs sm:grid-cols-4">
                <dt className="text-slate-500">Sends automatically</dt><dd>{yes(caps.automatedSend)}</dd>
                <dt className="text-slate-500">Delivery receipts</dt><dd>{yes(caps.deliveryReceipts)}</dd>
                <dt className="text-slate-500">Inbound</dt><dd>{caps.inbound.replace("_", " ")}</dd>
                <dt className="text-slate-500">Call audio access</dt><dd>{yes(caps.callAudioAccess)}</dd>
                <dt className="text-slate-500">Call recording</dt><dd>{yes(caps.callRecording)}</dd>
                <dt className="text-slate-500">Countries</dt><dd>{caps.supportedCountries.join(", ")}</dd>
              </dl>
              <ul className="list-disc pl-5 text-xs text-slate-600">{caps.limitations.map((l, i) => <li key={i}>{l}</li>)}</ul>
              {blockers.length > 0 && <p className="text-xs text-red-700">Blocked: {blockers.join("; ")}</p>}
              {admin && (
                <ActionForm action={providerAction} submitLabel="Save" className="flex flex-wrap items-end gap-3">
                  <input type="hidden" name="key" value={p.key} />
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="enabled" defaultChecked={p.enabled} className="h-5 w-5" /> Enabled</label>
                  {p.mode === "AUTOMATED" && (
                    <div className="min-w-0 flex-1">
                      <label className="label" htmlFor={`auth-${p.key}`}>Carrier/provider written authorisation reference</label>
                      <input className="input" id={`auth-${p.key}`} name="carrierAuthRef" defaultValue={p.carrierAuthRef ?? ""} placeholder="e.g. contract or approval letter ref" />
                    </div>
                  )}
                </ActionForm>
              )}
            </article>
          );
        })}
      </section>
    </div>
  );
}
