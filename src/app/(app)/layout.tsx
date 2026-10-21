import { requireUser } from "@/server/auth/current";
import { can } from "@/server/auth/rbac";
import { env } from "@/lib/env";
import { prisma } from "@/lib/db";
import { getHalt } from "@/server/compliance/controls";
import { workQueueCounts } from "@/server/today";
import { AppShell, type NavGroup, type NavItem } from "@/components/AppShell";
import { RegisterServiceWorker } from "@/components/RegisterServiceWorker";
import { logoutAction } from "../actions/auth";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const e = env();
  const [halt, counts] = await Promise.all([getHalt(prisma), workQueueCounts(prisma)]);
  const todayBadge = counts.smsToSend + counts.callsQueued + (can(user.role, "outreach.approve") ? counts.awaitingApproval : 0);

  const groups: NavGroup[] = [
    {
      label: "Outreach",
      items: [
        { href: "/today", label: "Today", icon: "✅", badge: todayBadge },
        { href: "/sms", label: "SMS", icon: "💬", badge: counts.smsToSend },
        { href: "/calls", label: "Calls", icon: "📞", badge: counts.callsQueued },
        { href: "/voice", label: "AI voice", icon: "🎙️" },
      ],
    },
    {
      label: "CRM",
      items: [
        { href: "/", label: "Dashboard", icon: "📊" },
        { href: "/contacts", label: "Contacts", icon: "👥" },
        { href: "/companies", label: "Companies", icon: "🏢" },
        { href: "/import", label: "Import", icon: "⬆️" },
      ],
    },
    { label: "Insights", items: [{ href: "/reports", label: "Reports", icon: "📈" }] },
    {
      label: "Settings",
      items: [
        { href: "/compliance", label: "Compliance", icon: "🛡️" },
        { href: "/providers", label: "Providers", icon: "📡" },
        { href: "/connect", label: "Connect phone", icon: "📱" },
        ...(can(user.role, "audit.read") ? [{ href: "/audit", label: "Audit log", icon: "🧾" }] : []),
        ...(can(user.role, "users.manage") ? [{ href: "/users", label: "Users", icon: "👤" }] : []),
      ],
    },
  ];
  const find = (href: string) => groups.flatMap((g) => g.items).find((i) => i.href === href)!;
  const tabs: NavItem[] = [find("/today"), find("/sms"), find("/calls"), find("/contacts")];

  const banners = (
    <>
      <div className="border-b border-amber-200 bg-amber-50 px-4 py-1 text-center text-[11px] text-amber-900 lg:text-xs" data-testid="mode-banner">
        {e.SIMULATION_MODE ? "SIMULATION MODE: fake providers and dummy leads. " : ""}
        Automated outreach: <strong>{e.ALLOW_AUTOMATED_OUTREACH ? "permitted by env (still needs provider authorisation)" : "DISABLED"}</strong>
      </div>
      {halt.halted && (
        <div className="bg-red-600 px-4 py-1.5 text-center text-xs font-semibold text-white" role="alert">EMERGENCY STOP ACTIVE: all outreach halted</div>
      )}
    </>
  );

  return (
    <AppShell groups={groups} tabs={tabs} userName={user.name} role={user.role} logout={logoutAction} banners={banners}>
      <RegisterServiceWorker />
      {children}
    </AppShell>
  );
}
