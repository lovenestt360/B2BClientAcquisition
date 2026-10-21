import Link from "next/link";
import { prisma } from "@/lib/db";
import { PageHeader, StageBadge, Empty } from "@/components/ui";

export default async function Companies({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  const companies = await prisma.company.findMany({
    where: q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { domain: { contains: q.toLowerCase() } }] } : undefined,
    include: { _count: { select: { contacts: true } } },
    orderBy: { name: "asc" },
    take: 200,
  });
  return (
    <div>
      <PageHeader title="Companies" subtitle={`${companies.length} shown`}>
        <Link href="/companies/new" className="btn-primary">Add company</Link>
      </PageHeader>
      <form className="mb-4 flex gap-2">
        <input className="input" name="q" defaultValue={q} placeholder="Search name or domain" aria-label="Search" />
        <button className="btn-secondary">Search</button>
      </form>
      {companies.length === 0 ? <Empty>No companies yet.</Empty> : (
        <div className="card overflow-x-auto p-0">
          <table className="tbl">
            <thead><tr><th>Name</th><th className="hidden sm:table-cell">Domain</th><th className="hidden md:table-cell">Industry</th><th>Contacts</th><th>Stage</th></tr></thead>
            <tbody>
              {companies.map((c) => (
                <tr key={c.id}>
                  <td><Link className="font-medium text-brand-700 hover:underline" href={`/companies/${c.id}`}>{c.name}</Link></td>
                  <td className="hidden sm:table-cell">{c.domain ?? "—"}</td>
                  <td className="hidden md:table-cell">{c.industry ?? "—"}</td>
                  <td>{c._count.contacts}</td>
                  <td><StageBadge stage={c.stage} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
