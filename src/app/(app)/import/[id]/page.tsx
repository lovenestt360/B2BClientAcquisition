import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { PageHeader, Stat } from "@/components/ui";
import Link from "next/link";
import { cancelImportAction, commitImportAction, deleteImportAction, researchImportAction } from "@/app/actions/import";
import { evaluateQualification } from "@/server/crm/qualification";

const ACTION_STYLE: Record<string, string> = {
  CREATE: "bg-green-100 text-green-800",
  MERGE: "bg-blue-100 text-blue-800",
  SKIP_DUPLICATE: "bg-amber-100 text-amber-800",
  INVALID: "bg-red-100 text-red-800",
};

export default async function ImportBatchPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ filter?: string }> }) {
  const { id } = await params;
  const { filter } = await searchParams;
  const batch = await prisma.importBatch.findUnique({ where: { id } });
  if (!batch) notFound();
  const rows = await prisma.importRow.findMany({
    where: { batchId: id, ...(filter ? { action: filter as never } : {}) },
    orderBy: { rowNumber: "asc" },
    take: 500,
  });
  const counts = await prisma.importRow.groupBy({ by: ["action"], where: { batchId: id }, _count: { _all: true } });
  const contactIds = [...new Set(rows.flatMap((row) => row.matchContactId ? [row.matchContactId] : []))];
  const contacts = batch.status === "COMMITTED" ? await prisma.contact.findMany({ where: { id: { in: contactIds } }, include: { phoneNumbers: { select: { source: true } }, company: true } }) : [];
  const research = contacts.map((contact) => ({ contact, readiness: evaluateQualification(contact) }));
  const n = (a: string) => counts.find((c) => c.action === a)?._count._all ?? 0;

  return (
    <div className="space-y-4">
      <PageHeader title={batch.fileName} subtitle={`Status: ${batch.status.toLowerCase()}`}>
        {batch.status === "PREVIEW" && (
          <>
            <form action={commitImportAction}><input type="hidden" name="batchId" value={id} /><button className="btn-primary">Commit {n("CREATE") + n("MERGE")} rows</button></form>
            <form action={cancelImportAction}><input type="hidden" name="batchId" value={id} /><button className="btn-secondary">Cancel</button></form>
          </>
        )}
      </PageHeader>
      {batch.error && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{batch.error}</p>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="import-counts">
        <Stat label="New" value={n("CREATE")} />
        <Stat label="Merge into existing" value={n("MERGE")} />
        <Stat label="Duplicates in file" value={n("SKIP_DUPLICATE")} />
        <Stat label="Invalid" value={n("INVALID")} />
      </div>
      {batch.status === "COMMITTED" && (
        <div className="card space-y-3" role="status">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div><p className="font-semibold text-green-800">Committed: {batch.createdRows} created, {batch.mergedRows} merged.</p><p className="text-sm text-slate-600">Gemini research with Google Search grounding ran after the import. Uncited or unverified values were not saved.</p></div>
            <form action={researchImportAction}><input type="hidden" name="batchId" value={id} /><button className="btn-secondary">Research missing data again</button></form>
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            <Stat label="Imported contacts" value={research.length} />
            <Stat label="Ready to qualify" value={research.filter((item) => item.readiness.ready).length} />
            <Stat label="Need more research" value={research.filter((item) => !item.readiness.ready).length} />
          </div>
          {research.filter((item) => !item.readiness.ready).map(({ contact, readiness }) => <div key={contact.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-amber-200 bg-amber-50 p-3 text-sm"><span><strong>{contact.firstName} {contact.lastName}</strong> — missing: {readiness.checks.filter((check) => !check.passed).map((check) => check.label.toLowerCase()).join(", ")}</span><Link className="text-brand-700" href={`/contacts/${contact.id}`}>Review contact</Link></div>)}
        </div>
      )}
      <div className="flex flex-wrap gap-2 text-sm">
        {["", "CREATE", "MERGE", "SKIP_DUPLICATE", "INVALID"].map((f) => (
          <a key={f} href={f ? `?filter=${f}` : "?"} className={`badge ${filter === f || (!filter && !f) ? "bg-slate-800 text-white" : "bg-slate-100"}`}>{f ? f.toLowerCase().replace("_", " ") : "all"}</a>
        ))}
      </div>
      <div className="card overflow-x-auto p-0">
        <table className="tbl">
          <thead><tr><th>Row</th><th>Action</th><th>Name</th><th className="hidden sm:table-cell">Email / phone</th><th>Notes</th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const norm = r.normalized as { firstName?: string; lastName?: string; email?: string; phone?: { e164: string } } | null;
              const raw = r.raw as Record<string, string>;
              const errs = (r.errors as string[] | null) ?? [];
              return (
                <tr key={r.id}>
                  <td>{r.rowNumber}</td>
                  <td><span className={`badge ${ACTION_STYLE[r.action]}`}>{r.action.toLowerCase().replace("_", " ")}</span></td>
                  <td>{norm ? `${norm.firstName} ${norm.lastName ?? ""}` : Object.values(raw).slice(0, 2).join(" ")}</td>
                  <td className="hidden sm:table-cell">{norm?.email ?? ""} {norm?.phone?.e164 ?? ""}</td>
                  <td className="text-xs">
                    {r.matchReason && <div>match: {r.matchReason}</div>}
                    {errs.map((e, i) => <div key={i} className={e.startsWith("warning") ? "text-amber-700" : "text-red-700"}>{e}</div>)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {batch.status !== "COMMITTING" && (
        <section id="delete-import" className="card scroll-mt-4 border-red-200 space-y-3">
          <div>
            <h2 className="font-semibold text-red-800">Delete import and its contacts</h2>
            <p className="text-sm text-slate-600">This permanently deletes this import and all {batch.createdRows} contacts originally created by it. Pre-existing contacts that were only merged are kept. This cannot be undone.</p>
          </div>
          <form action={deleteImportAction} className="flex max-w-xl flex-col gap-2 sm:flex-row">
            <input type="hidden" name="batchId" value={id} />
            <input className="input" name="confirmation" required autoComplete="off" placeholder={`Type ${batch.fileName} to confirm`} aria-label="File name confirmation" />
            <button className="btn-secondary whitespace-nowrap border-red-300 text-red-700">Delete permanently</button>
          </form>
        </section>
      )}
    </div>
  );
}
