import { describe, expect, it, vi } from "vitest";
import { deleteImportWithCreatedContacts } from "@/server/import/service";

function fakeDb(confirmation = "old.csv") {
  const tx = {
    contact: {
      findMany: vi.fn().mockResolvedValue([{ id: "created-1", companyId: "company-1" }]),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    company: {
      findUnique: vi.fn().mockResolvedValue({ sourceRef: "import:batch-1", _count: { contacts: 0 } }),
      delete: vi.fn().mockResolvedValue({}),
    },
    importBatch: { delete: vi.fn().mockResolvedValue({}) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  const db = {
    importBatch: { findUnique: vi.fn().mockResolvedValue({ id: "batch-1", fileName: confirmation, status: "COMMITTED" }) },
    $transaction: vi.fn(async (fn: (value: typeof tx) => unknown) => fn(tx)),
  };
  return { db, tx };
}

describe("deleting an import", () => {
  it("deletes contacts created by the batch and orphan companies, then the batch", async () => {
    const { db, tx } = fakeDb();
    await expect(deleteImportWithCreatedContacts(db as never, "batch-1", "old.csv", "user-1")).resolves.toEqual({ deletedContacts: 1, deletedCompanies: 1 });
    expect(tx.contact.findMany).toHaveBeenCalledWith({ where: { sourceRef: "import:batch-1" }, select: { id: true, companyId: true } });
    expect(tx.contact.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["created-1"] } } });
    expect(tx.company.delete).toHaveBeenCalledWith({ where: { id: "company-1" } });
    expect(tx.importBatch.delete).toHaveBeenCalledWith({ where: { id: "batch-1" } });
    expect(tx.auditLog.create).toHaveBeenCalled();
  });

  it("requires the exact file name and performs no transaction otherwise", async () => {
    const { db } = fakeDb();
    await expect(deleteImportWithCreatedContacts(db as never, "batch-1", "wrong.csv", "user-1")).rejects.toThrow(/exact file name/);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
