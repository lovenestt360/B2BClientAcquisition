import { requireUser } from "@/server/auth/current";
import { can } from "@/server/auth/rbac";
import { env } from "@/lib/env";
import { Nav, type NavItem } from "@/components/Nav";
import { logoutAction } from "../actions/auth";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const e = env();
  const items: NavItem[] = [
    { href: "/", label: "Dashboard" },
    { href: "/contacts", label: "Contacts" },
    { href: "/companies", label: "Companies" },
    { href: "/import", label: "Import" },
  ];
  if (can(user.role, "audit.read")) items.push({ href: "/audit", label: "Audit log" });
  if (can(user.role, "users.manage")) items.push({ href: "/users", label: "Users" });

  return (
    <>
      <Nav items={items} userName={user.name} role={user.role} logout={logoutAction} />
      <div className="border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-center text-xs text-amber-900" data-testid="mode-banner">
        {e.SIMULATION_MODE ? "SIMULATION MODE: fake providers and dummy leads. " : ""}
        Automated outreach: <strong>{e.ALLOW_AUTOMATED_OUTREACH ? "permitted by env (still needs provider authorisation)" : "DISABLED"}</strong>
      </div>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </>
  );
}
