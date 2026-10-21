import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { PageHeader, StageBadge, Empty, fmtDate } from "@/components/ui";

export default async function CompanyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const c = await prisma.company.findUnique({
    where: { id },
    include: { contacts: { orderBy: { firstName: "asc" } }, researchFacts: { orderBy: { verifiedAt: "desc" } } },
  });
  if (!c) notFound();
  return (
    <div className="space-y-4">
      <PageHeader title={c.name} subtitle={[c.domain, c.industry, c.city, c.country].filter(Boolean).join(" · ")}>
        <StageBadge stage={c.stage} />
      </PageHeader>
      <section className="card">
        <h2 className="mb-2 font-semibold">Contacts ({c.contacts.length})</h2>
        {c.contacts.length === 0 ? <Empty>No contacts</Empty> : (
          <ul className="divide-y divide-slate-100 text-sm">
            {c.contacts.map((p) => (
              <li key={p.id} className="flex justify-between py-2">
                <Link className="text-brand-700 hover:underline" href={`/contacts/${p.id}`}>{p.firstName} {p.lastName}</Link>
                <span className="muted">{p.title}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="card text-sm">
        <h2 className="mb-2 font-semibold">Research facts</h2>
        <p className="muted mb-2">Every fact needs a source URL, a verification time and a confidence score.</p>
        {c.researchFacts.length === 0 ? <Empty>No sourced research yet</Empty> : (
          <ul className="space-y-1">
            {c.researchFacts.map((f) => (
              <li key={f.id}>
                <strong>{f.field}</strong>: {f.value}{" "}
                <a className="text-brand-700 hover:underline" href={f.sourceUrl} target="_blank" rel="noreferrer">source</a>{" "}
                <span className="muted">conf {Math.round(f.confidence * 100)}% · {fmtDate(f.verifiedAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
