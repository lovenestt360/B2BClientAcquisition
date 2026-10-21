import type { Db } from "@/lib/db";
import { commitImport } from "../import/service";

export const handlers = {
  "import.commit": async (db: Db, p: { batchId: string; userId: string | null }) => {
    const b = await commitImport(db, p.batchId, p.userId);
    return { created: b.createdRows, merged: b.mergedRows };
  },
};

export type QueueName = keyof typeof handlers;
