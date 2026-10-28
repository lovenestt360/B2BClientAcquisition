import Link from "next/link";
import { prisma } from "@/lib/db";
import { ActionForm } from "@/components/ActionForm";
import { PageHeader, fmtDate } from "@/components/ui";
import { uploadImportAction } from "@/app/actions/import";

export default async function ImportPage() {
  const batches = await prisma.importBatch.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
  return (
    <div className="space-y-4">
      <PageHeader title="Import leads" subtitle="CSV or XLSX. Rows are validated and deduplicated before anything is saved." />
      <div className="card max-w-xl">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold">Upload contact data</h2>
            <p className="text-sm text-slate-600">Use one row per person. Preview and resolve warnings before committing.</p>
          </div>
          <a className="btn-secondary whitespace-nowrap" href="/api/import/template">Download Template</a>
        </div>
        <ActionForm action={uploadImportAction} submitLabel="Upload & preview">
          <input className="input" type="file" name="file" accept=".csv,.xlsx" aria-label="File" required />
          <p className="text-xs text-slate-500">
            Recognised columns: First Name, Last Name (or Name), Email, Phone/Mobile, Title, Company, Website/Domain,
            Industry, Country, City, LinkedIn. Only import data you collected lawfully and can source.
          </p>
        </ActionForm>
      </div>
      <section className="card overflow-x-auto p-0">
        <table className="tbl">
          <thead><tr><th>File</th><th>Status</th><th>Rows</th><th className="hidden sm:table-cell">Created / merged / skipped / invalid</th><th className="hidden md:table-cell">When</th><th>Actions</th></tr></thead>
          <tbody>
            {batches.map((b) => (
              <tr key={b.id}>
                <td><Link className="text-brand-700 hover:underline" href={`/import/${b.id}`}>{b.fileName}</Link></td>
                <td>{b.status.toLowerCase()}</td>
                <td>{b.totalRows}</td>
                <td className="hidden sm:table-cell">{b.createdRows} / {b.mergedRows} / {b.skippedRows} / {b.invalidRows}</td>
                <td className="hidden md:table-cell">{fmtDate(b.createdAt)}</td>
                <td>{b.status === "COMMITTING" ? <span className="text-xs text-slate-500">In progress</span> : <Link className="text-sm font-medium text-red-700 hover:underline" href={`/import/${b.id}#delete-import`}>Delete…</Link>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
