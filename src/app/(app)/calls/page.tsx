import Link from "next/link";
import { prisma } from "@/lib/db";
import { ActionForm } from "@/components/ActionForm";
import { Empty, ModeBadge, PageHeader, fmtDate } from "@/components/ui";
import { queueCallAction } from "@/app/actions/outreach";
import { CallCard } from "@/components/outreach/CallCard";


export default async function CallsPage() {
  const provider = await prisma.providerConfig.findUnique({ where: { key: "iphone_manual_call" } });
  const queue = await prisma.call.findMany({
    where: { mode: "MANUAL", status: { in: ["QUEUED", "DIALING"] } },
    include: { contact: { include: { company: true, phoneNumbers: true } } },
    orderBy: { createdAt: "asc" },
  });
  const recent = await prisma.call.findMany({
    where: { status: { notIn: ["QUEUED", "DIALING"] } },
    include: { contact: { select: { id: true, firstName: true, lastName: true } } },
    orderBy: { updatedAt: "desc" },
    take: 20,
  });
  const contacts = await prisma.contact.findMany({
    where: { phoneNumbers: { some: {} } },
    select: { id: true, firstName: true, lastName: true, isSimulated: true, company: { select: { name: true } } },
    orderBy: { firstName: "asc" },
    take: 300,
  });

  return (
    <div className="space-y-6">
      <PageHeader title="Calls" subtitle="You dial from your iPhone. The platform shows guidance and records the outcome you report.">
        <ModeBadge mode="MANUAL" />
        <Link className="btn-secondary" href="/voice">AI voice sandbox</Link>
      </PageHeader>
      {!provider?.enabled && (
        <Empty>Manual iPhone calling is disabled. An admin can enable it on the <Link className="underline" href="/providers">Providers</Link> page.</Empty>
      )}
      {provider?.enabled && (
        <section className="card max-w-xl">
          <ActionForm action={queueCallAction} submitLabel="Add to call queue" className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1">
              <label className="label" htmlFor="contactId">Contact</label>
              <select className="input" id="contactId" name="contactId" required>
                {contacts.map((c) => <option key={c.id} value={c.id}>{c.firstName} {c.lastName}{c.company ? ` – ${c.company.name}` : ""}{c.isSimulated ? " (dummy)" : ""}</option>)}
              </select>
            </div>
          </ActionForm>
        </section>
      )}

      <section className="space-y-3" aria-labelledby="queue">
        <h2 id="queue" className="font-semibold">Call queue ({queue.length})</h2>
        {queue.length === 0 && <Empty>The queue is empty.</Empty>}
        {queue.map((call) => <CallCard key={call.id} call={call} />)}
      </section>

      <section className="card overflow-x-auto p-0">
        <h2 className="p-4 pb-0 font-semibold">Recent calls</h2>
        <table className="tbl">
          <thead><tr><th>Contact</th><th>Channel</th><th>Outcome</th><th className="hidden sm:table-cell">When</th></tr></thead>
          <tbody>
            {recent.map((c) => (
              <tr key={c.id}>
                <td><Link className="text-brand-700" href={`/calls/${c.id}`}>{c.contact ? `${c.contact.firstName} ${c.contact.lastName ?? ""}` : "Sandbox caller"}</Link></td>
                <td><ModeBadge mode={c.mode} /></td>
                <td>{c.outcome?.replace(/_/g, " ").toLowerCase() ?? c.status.toLowerCase()}</td>
                <td className="hidden sm:table-cell">{fmtDate(c.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
