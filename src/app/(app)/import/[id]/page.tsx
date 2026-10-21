import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { PageHeader, Stat } from "@/components/ui";
import { cancelImportAction, commitImportAction } from "@/app/actions/import";

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
        <p className="rounded bg-green-50 p-2 text-sm text-green-800" role="status">
          Committed: {batch.createdRows} created, {batch.mergedRows} merged.
        </p>
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
    </div>
  );
}
