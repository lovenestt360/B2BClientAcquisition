import Link from "next/link";
import type { PipelineStage } from "@prisma/client";
import { prisma } from "@/lib/db";
import { listContacts } from "@/server/crm/contacts";
import { PageHeader, StageBadge, Empty } from "@/components/ui";

export default async function Contacts({ searchParams }: { searchParams: Promise<{ q?: string; stage?: string; page?: string }> }) {
  const sp = await searchParams;
  const { items, total, page, pageSize } = await listContacts(prisma, {
    q: sp.q,
    stage: (sp.stage || undefined) as PipelineStage | undefined,
    page: Number(sp.page ?? 1),
  });
  const pages = Math.ceil(total / pageSize);
  return (
    <div>
      <PageHeader title="Contacts" subtitle={`${total} total`}>
        <Link href="/contacts/new" className="btn-primary">Add contact</Link>
      </PageHeader>
      <form className="mb-4 flex gap-2">
        <input className="input" name="q" defaultValue={sp.q} placeholder="Search name, email, company, phone" aria-label="Search" />
        <button className="btn-secondary">Search</button>
      </form>
      {items.length === 0 ? <Empty>No contacts match.</Empty> : (
        <div className="card overflow-x-auto p-0">
          <table className="tbl">
            <thead><tr><th>Name</th><th className="hidden sm:table-cell">Company</th><th className="hidden md:table-cell">Email</th><th className="hidden md:table-cell">Phone</th><th>Stage</th></tr></thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link href={`/contacts/${c.id}`} className="font-medium text-brand-700 hover:underline">{c.firstName} {c.lastName}</Link>
                    {c.isSimulated && <span className="badge ml-1 bg-violet-100 text-violet-800">dummy</span>}
                    <div className="text-xs text-slate-500">{c.title}</div>
                  </td>
                  <td className="hidden sm:table-cell">{c.company?.name ?? "—"}</td>
                  <td className="hidden md:table-cell">{c.email ?? "—"}</td>
                  <td className="hidden md:table-cell">{c.phoneNumbers[0]?.e164 ?? "—"}</td>
                  <td><StageBadge stage={c.stage} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pages > 1 && (
        <div className="mt-3 flex justify-between text-sm">
          {page > 1 ? <Link className="btn-secondary" href={`?q=${sp.q ?? ""}&page=${page - 1}`}>Previous</Link> : <span />}
          <span className="muted">Page {page} of {pages}</span>
          {page < pages ? <Link className="btn-secondary" href={`?q=${sp.q ?? ""}&page=${page + 1}`}>Next</Link> : <span />}
        </div>
      )}
    </div>
  );
}
