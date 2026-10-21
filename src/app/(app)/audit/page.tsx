import { prisma } from "@/lib/db";
import { requireRole } from "@/server/auth/current";
import { PageHeader, fmtDate } from "@/components/ui";

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ action?: string }> }) {
  await requireRole("MANAGER");
  const { action } = await searchParams;
  const logs = await prisma.auditLog.findMany({
    where: action ? { action: { startsWith: action } } : undefined,
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { actor: { select: { name: true, email: true } } },
  });
  return (
    <div>
      <PageHeader title="Audit log" subtitle="Every state-changing action, newest first" />
      <form className="mb-3 flex gap-2">
        <input className="input" name="action" defaultValue={action} placeholder="Filter by action prefix, e.g. sms." aria-label="Action filter" />
        <button className="btn-secondary">Filter</button>
      </form>
      <div className="card overflow-x-auto p-0">
        <table className="tbl">
          <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th className="hidden md:table-cell">Details</th></tr></thead>
          <tbody>
            {logs.map((l) => (
              <tr key={l.id}>
                <td className="whitespace-nowrap">{fmtDate(l.createdAt)}</td>
                <td>{l.actor?.name ?? l.actorType}</td>
                <td><code className="text-xs">{l.action}</code></td>
                <td className="text-xs">{l.entityType}{l.entityId ? ` · ${l.entityId.slice(0, 10)}` : ""}</td>
                <td className="hidden max-w-sm truncate text-xs md:table-cell">{l.metadata ? JSON.stringify(l.metadata) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
