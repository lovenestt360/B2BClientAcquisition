import type { Role } from "@prisma/client";
import { ForbiddenError } from "../errors";

/** Ordered from least to most privileged. */
const RANK: Record<Role, number> = { VIEWER: 0, OPERATOR: 1, MANAGER: 2, ADMIN: 3 };

export type Permission =
  | "crm.read"
  | "crm.write"
  | "import.run"
  | "outreach.draft"
  | "outreach.approve"
  | "outreach.execute"
  | "compliance.manage"
  | "providers.manage"
  | "emergency_stop"
  | "users.manage"
  | "audit.read";

const MIN_ROLE: Record<Permission, Role> = {
  "crm.read": "VIEWER",
  "audit.read": "MANAGER",
  "crm.write": "OPERATOR",
  "import.run": "OPERATOR",
  "outreach.draft": "OPERATOR",
  "outreach.execute": "OPERATOR",
  // Any operator can halt outreach; resuming requires a manager (see compliance/controls).
  emergency_stop: "OPERATOR",
  "outreach.approve": "MANAGER",
  "compliance.manage": "MANAGER",
  "providers.manage": "ADMIN",
  "users.manage": "ADMIN",
};

export function can(role: Role, permission: Permission): boolean {
  return RANK[role] >= RANK[MIN_ROLE[permission]];
}

export function assertCan(role: Role, permission: Permission): void {
  if (!can(role, permission)) throw new ForbiddenError(`Requires permission ${permission}`);
}

export function atLeast(role: Role, min: Role): boolean {
  return RANK[role] >= RANK[min];
}
