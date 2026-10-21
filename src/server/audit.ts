import type { Prisma } from "@prisma/client";
import type { Db } from "@/lib/db";

export interface AuditInput {
  actorId?: string | null;
  actorType?: "user" | "system" | "job";
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Prisma.InputJsonValue;
  ipAddress?: string | null;
}

type Tx = Pick<Db, "auditLog">;

export async function audit(db: Tx, input: AuditInput) {
  return db.auditLog.create({
    data: {
      actorId: input.actorId ?? null,
      actorType: input.actorType ?? (input.actorId ? "user" : "system"),
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      metadata: input.metadata,
      ipAddress: input.ipAddress ?? null,
    },
  });
}
