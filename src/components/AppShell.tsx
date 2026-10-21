"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

export interface NavItem {
  href: string;
  label: string;
  icon: string;
  badge?: number;
}
export interface NavGroup {
  label: string;
  items: NavItem[];
}

const isActive = (path: string, href: string) => (href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`));

/**
 * Laptop (lg+): left sidebar with grouped navigation.
 * Phone: slim top bar + bottom tab bar (thumb reach) + "More" sheet for everything else.
 */
export function AppShell({
  groups,
  tabs,
  userName,
  role,
  logout,
  banners,
  children,
}: {
  groups: NavGroup[];
  tabs: NavItem[];
  userName: string;
  role: string;
  logout: () => void;
  banners: ReactNode;
  children: ReactNode;
}) {
  const path = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => setMoreOpen(false), [path]);
  const all = groups.flatMap((g) => g.items);
  const current = all.find((i) => isActive(path, i.href));

  return (
    <div className="min-h-screen lg:flex">
      {/* ── Laptop sidebar ── */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-slate-200 bg-white lg:flex" aria-label="Sidebar">
        <Link href="/" className="px-5 py-4 text-base font-semibold text-brand-700">Client Acquisition</Link>
        <nav className="flex-1 space-y-4 overflow-y-auto px-3 pb-4" aria-label="Main">
          {groups.map((g) => (
            <div key={g.label}>
              <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{g.label}</p>
              {g.items.map((i) => (
                <Link
                  key={i.href}
                  href={i.href}
                  aria-current={isActive(path, i.href) ? "page" : undefined}
                  className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm ${isActive(path, i.href) ? "bg-brand-50 font-medium text-brand-700" : "text-slate-700 hover:bg-slate-100"}`}
                >
                  <span aria-hidden className="w-5 text-center">{i.icon}</span>
                  <span className="flex-1">{i.label}</span>
                  {!!i.badge && <span className="rounded-full bg-brand-600 px-1.5 text-[11px] text-white">{i.badge}</span>}
                </Link>
              ))}
            </div>
          ))}
        </nav>
        <div className="border-t border-slate-200 px-4 py-3 text-sm">
          <p className="truncate font-medium">{userName}</p>
          <p className="text-xs text-slate-500">{role.toLowerCase()}</p>
          <form action={logout}><button className="mt-1 text-xs text-slate-500 hover:text-slate-800">Sign out</button></form>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        {/* ── Phone top bar ── */}
        <header className="sticky top-0 z-20 flex items-center justify-between border-b border-slate-200 bg-white/95 px-4 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))] backdrop-blur lg:hidden">
          <span className="font-semibold text-slate-900">{current?.label ?? "Client Acquisition"}</span>
          <span className="text-xs text-slate-500">{userName}</span>
        </header>
        {banners}
        <main className="mx-auto max-w-6xl px-4 pb-28 pt-4 lg:px-8 lg:pb-10 lg:pt-6">{children}</main>
      </div>

      {/* ── Phone bottom tabs ── */}
      <nav
        className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-slate-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
        aria-label="Tabs"
      >
        {tabs.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            aria-current={isActive(path, t.href) ? "page" : undefined}
            className={`relative flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px] ${isActive(path, t.href) ? "text-brand-700" : "text-slate-500"}`}
          >
            <span aria-hidden className="text-lg leading-none">{t.icon}</span>
            {t.label}
            {!!t.badge && <span className="absolute right-[22%] top-1.5 min-w-4 rounded-full bg-red-600 px-1 text-[10px] leading-4 text-white">{t.badge}</span>}
          </Link>
        ))}
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          aria-expanded={moreOpen}
          className={`flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px] ${moreOpen ? "text-brand-700" : "text-slate-500"}`}
        >
          <span aria-hidden className="text-lg leading-none">☰</span>
          More
        </button>
      </nav>

      {/* ── Phone "More" sheet ── */}
      {moreOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="More">
          <button className="absolute inset-0 bg-black/30" aria-label="Close menu" onClick={() => setMoreOpen(false)} />
          <div className="absolute inset-x-0 bottom-0 max-h-[80vh] overflow-y-auto rounded-t-2xl bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            {groups.map((g) => (
              <div key={g.label} className="mb-3">
                <p className="pb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{g.label}</p>
                <div className="grid grid-cols-3 gap-2">
                  {g.items.map((i) => (
                    <Link key={i.href} href={i.href} className={`flex flex-col items-center gap-1 rounded-xl border p-3 text-center text-xs ${isActive(path, i.href) ? "border-brand-600 text-brand-700" : "border-slate-200 text-slate-700"}`}>
                      <span aria-hidden className="text-xl">{i.icon}</span>
                      {i.label}
                    </Link>
                  ))}
                </div>
              </div>
            ))}
            <form action={logout} className="mt-2 text-center"><button className="btn-secondary w-full">Sign out ({userName})</button></form>
          </div>
        </div>
      )}
    </div>
  );
}
