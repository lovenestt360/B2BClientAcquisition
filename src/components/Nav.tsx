"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

export interface NavItem {
  href: string;
  label: string;
}

export function Nav({ items, userName, role, logout }: { items: NavItem[]; userName: string; role: string; logout: () => void }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const active = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  return (
    <header className="sticky top-0 z-20 border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-2">
        <Link href="/" className="font-semibold text-brand-700">Client Acquisition</Link>
        <button className="btn-secondary md:hidden" aria-label="Menu" aria-expanded={open} onClick={() => setOpen(!open)}>
          ☰
        </button>
        <nav className="hidden items-center gap-1 md:flex">
          {items.map((i) => (
            <Link key={i.href} href={i.href} className={`rounded-md px-2 py-1 text-sm ${active(i.href) ? "bg-brand-50 text-brand-700" : "text-slate-600 hover:bg-slate-100"}`}>
              {i.label}
            </Link>
          ))}
          <form action={logout} className="ml-2">
            <button className="text-sm text-slate-500 hover:text-slate-800" title={`${userName} (${role})`}>Sign out</button>
          </form>
        </nav>
      </div>
      {open && (
        <nav className="grid grid-cols-2 gap-1 border-t border-slate-200 px-4 py-2 md:hidden">
          {items.map((i) => (
            <Link key={i.href} href={i.href} onClick={() => setOpen(false)} className={`rounded-md px-2 py-2 text-sm ${active(i.href) ? "bg-brand-50 text-brand-700" : "text-slate-700"}`}>
              {i.label}
            </Link>
          ))}
          <form action={logout}>
            <button className="px-2 py-2 text-sm text-slate-500">Sign out ({userName})</button>
          </form>
        </nav>
      )}
    </header>
  );
}
