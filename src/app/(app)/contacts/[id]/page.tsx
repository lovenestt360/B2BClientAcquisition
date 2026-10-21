import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/auth/rbac";
import { changeStageAction } from "@/app/actions/crm";
import { PageHeader, StageBadge, fmtDate } from "@/components/ui";

const STAGES = ["NEW", "RESEARCHING", "QUALIFIED", "CONTACTED", "ENGAGED", "MEETING_BOOKED", "PROPOSAL", "WON", "LOST", "DISQUALIFIED"];

export default async function ContactPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const c = await prisma.contact.findUnique({
    where: { id },
    include: { company: true, phoneNumbers: { orderBy: { isPrimary: "desc" } } },
  });
  if (!c) notFound();
  const history = await prisma.auditLog.findMany({
    where: { entityType: "contact", entityId: id },
    orderBy: { createdAt: "desc" },
    take: 20,
    include: { actor: { select: { name: true } } },
  });

  return (
    <div className="space-y-4">
      <PageHeader title={`${c.firstName} ${c.lastName ?? ""}`} subtitle={[c.title, c.company?.name].filter(Boolean).join(" · ")}>
        <StageBadge stage={c.stage} />
      </PageHeader>
      {c.isSimulated && <p className="rounded-lg bg-violet-50 p-2 text-sm text-violet-800">Seeded dummy lead for simulation. Not a real person.</p>}

      <div className="grid gap-4 md:grid-cols-2">
        <section className="card space-y-2 text-sm">
          <h2 className="font-semibold">Details</h2>
          <dl className="grid grid-cols-3 gap-y-1">
            <dt className="text-slate-500">Email</dt>
            <dd className="col-span-2 break-all">{c.email ?? "—"} {c.emailSource && <span className="text-xs text-slate-400">({c.emailSource})</span>}</dd>
            <dt className="text-slate-500">Company</dt>
            <dd className="col-span-2">{c.company ? <Link className="text-brand-700 hover:underline" href={`/companies/${c.company.id}`}>{c.company.name}</Link> : "—"}</dd>
            <dt className="text-slate-500">Country</dt><dd className="col-span-2">{c.country ?? "—"}</dd>
            <dt className="text-slate-500">LinkedIn</dt>
            <dd className="col-span-2 break-all">{c.linkedinUrl ? <a className="text-brand-700 hover:underline" href={c.linkedinUrl} target="_blank" rel="noreferrer">profile</a> : "—"}</dd>
            <dt className="text-slate-500">Source</dt><dd className="col-span-2">{c.sourceType}{c.sourceRef ? ` · ${c.sourceRef}` : ""}</dd>
            <dt className="text-slate-500">Existing customer</dt><dd className="col-span-2">{c.isExistingCustomer ? "yes" : "no"}</dd>
          </dl>
          {c.notes && <p className="whitespace-pre-wrap rounded bg-slate-50 p-2">{c.notes}</p>}
        </section>

        <section className="card text-sm">
          <h2 className="mb-2 font-semibold">Phone numbers</h2>
          {c.phoneNumbers.length === 0 ? <p className="muted">None on record</p> : (
            <ul className="space-y-1">
              {c.phoneNumbers.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-2">
                  <span className="font-mono">{p.e164}</span>
                  <span className="badge bg-slate-100">{p.type.toLowerCase()}</span>
                  {p.isPrimary && <span className="badge bg-brand-50 text-brand-700">primary</span>}
                  <span className="text-xs text-slate-400">source: {p.source}{p.verifiedAt ? ` · verified ${fmtDate(p.verifiedAt)}` : " · unverified"}</span>
                </li>
              ))}
            </ul>
          )}
          {can(user.role, "crm.write") && (
            <form action={changeStageAction} className="mt-4 flex gap-2">
              <input type="hidden" name="contactId" value={c.id} />
              <select name="stage" className="input" defaultValue={c.stage} aria-label="Stage">
                {STAGES.map((s) => <option key={s} value={s}>{s.replace(/_/g, " ").toLowerCase()}</option>)}
              </select>
              <button className="btn-secondary">Update stage</button>
            </form>
          )}
        </section>
      </div>

      <section className="card text-sm">
        <h2 className="mb-2 font-semibold">History</h2>
        <ul className="divide-y divide-slate-100">
          {history.map((h) => (
            <li key={h.id} className="flex justify-between gap-2 py-1.5">
              <span><code className="text-xs">{h.action}</code> <span className="muted">{h.actor?.name ?? h.actorType}</span></span>
              <span className="muted">{fmtDate(h.createdAt)}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
