import type { Db } from "@/lib/db";

export async function dashboardStats(db: Db) {
  const [companies, contacts, simulated, byStage, imports, recentAudit, reachable] = await Promise.all([
    db.company.count(),
    db.contact.count(),
    db.contact.count({ where: { isSimulated: true } }),
    db.contact.groupBy({ by: ["stage"], _count: { _all: true } }),
    db.importBatch.findMany({ orderBy: { createdAt: "desc" }, take: 5 }),
    db.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 8, include: { actor: { select: { name: true } } } }),
    db.contact.count({ where: { OR: [{ email: { not: null } }, { phoneNumbers: { some: {} } }] } }),
  ]);
  return {
    companies,
    contacts,
    simulated,
    reachable,
    byStage: Object.fromEntries(byStage.map((s) => [s.stage, s._count._all])) as Record<string, number>,
    imports,
    recentAudit,
  };
}
