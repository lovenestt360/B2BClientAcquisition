import Link from "next/link";
import { prisma } from "@/lib/db";
import { dashboardStats } from "@/server/dashboard";
import { Stat, PageHeader, StageBadge, fmtDate, Empty } from "@/components/ui";

const STAGES = ["NEW", "RESEARCHING", "QUALIFIED", "CONTACTED", "ENGAGED", "MEETING_BOOKED", "PROPOSAL", "WON", "LOST", "DISQUALIFIED"];

export default async function Dashboard() {
  const s = await dashboardStats(prisma);
  const max = Math.max(1, ...Object.values(s.byStage));
  return (
    <div className="space-y-6">
      <PageHeader title="Dashboard" subtitle="Pipeline and data health at a glance">
        <Link href="/import" className="btn-primary">Import leads</Link>
        <Link href="/contacts/new" className="btn-secondary">Add contact</Link>
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Contacts" value={s.contacts} hint={s.simulated ? `${s.simulated} simulated` : undefined} />
        <Stat label="Companies" value={s.companies} />
        <Stat label="Reachable" value={s.reachable} hint="have an email or phone" />
        <Stat label="Meetings booked" value={s.byStage.MEETING_BOOKED ?? 0} />
      </div>

      <section className="card" aria-labelledby="pipeline">
        <h2 id="pipeline" className="mb-3 font-semibold">Pipeline</h2>
        <div className="space-y-2">
          {STAGES.map((st) => (
            <div key={st} className="flex items-center gap-2 text-sm">
              <div className="w-32 shrink-0"><StageBadge stage={st} /></div>
              <div className="h-3 flex-1 rounded bg-slate-100">
                <div className="h-3 rounded bg-brand-600" style={{ width: `${((s.byStage[st] ?? 0) / max) * 100}%` }} />
              </div>
              <div className="w-10 text-right tabular-nums">{s.byStage[st] ?? 0}</div>
            </div>
          ))}
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <section className="card">
          <h2 className="mb-2 font-semibold">Recent imports</h2>
          {s.imports.length === 0 ? <Empty>No imports yet</Empty> : (
            <ul className="divide-y divide-slate-100 text-sm">
              {s.imports.map((b) => (
                <li key={b.id} className="flex justify-between py-2">
                  <Link href={`/import/${b.id}`} className="text-brand-700 hover:underline">{b.fileName}</Link>
                  <span className="muted">{b.status.toLowerCase()} · {b.totalRows} rows</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="card">
          <h2 className="mb-2 font-semibold">Recent activity</h2>
          <ul className="divide-y divide-slate-100 text-sm">
            {s.recentAudit.map((a) => (
              <li key={a.id} className="flex justify-between gap-2 py-2">
                <span><code className="text-xs">{a.action}</code> <span className="muted">{a.actor?.name ?? a.actorType}</span></span>
                <span className="muted shrink-0">{fmtDate(a.createdAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
