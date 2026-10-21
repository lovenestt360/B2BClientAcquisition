import type { ReactNode } from "react";

const STAGE_COLORS: Record<string, string> = {
  NEW: "bg-slate-100 text-slate-700",
  RESEARCHING: "bg-indigo-100 text-indigo-700",
  QUALIFIED: "bg-blue-100 text-blue-700",
  CONTACTED: "bg-cyan-100 text-cyan-700",
  ENGAGED: "bg-teal-100 text-teal-700",
  MEETING_BOOKED: "bg-emerald-100 text-emerald-700",
  PROPOSAL: "bg-amber-100 text-amber-800",
  WON: "bg-green-100 text-green-800",
  LOST: "bg-rose-100 text-rose-700",
  DISQUALIFIED: "bg-zinc-200 text-zinc-700",
};

export function StageBadge({ stage }: { stage: string }) {
  return <span className={`badge ${STAGE_COLORS[stage] ?? "bg-slate-100"}`}>{stage.replace(/_/g, " ").toLowerCase()}</span>;
}

const MODE_COLORS: Record<string, string> = {
  MANUAL: "bg-sky-100 text-sky-800",
  SIMULATED: "bg-violet-100 text-violet-800",
  AUTOMATED: "bg-orange-100 text-orange-800",
};

/** Every channel action shows which kind of channel it is. */
export function ModeBadge({ mode }: { mode: string }) {
  const label = mode === "MANUAL" ? "Manual (you send/dial)" : mode === "SIMULATED" ? "Simulated" : "Automated";
  return <span className={`badge ${MODE_COLORS[mode] ?? ""}`}>{label}</span>;
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="card">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

export function PageHeader({ title, children, subtitle }: { title: string; subtitle?: string; children?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
      <div>
        <h1 className="h1">{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">{children}</div>;
}

export function fmtDate(d: Date | string | null | undefined) {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-ZA", { timeZone: process.env.APP_TIMEZONE ?? "Africa/Johannesburg", dateStyle: "medium", timeStyle: "short" });
}

const DELIVERY: Record<string, [string, string]> = {
  NOT_ATTEMPTED: ["not attempted", "bg-slate-100 text-slate-700"],
  ATTEMPTED: ["attempted", "bg-sky-100 text-sky-800"],
  ACCEPTED: ["accepted by provider", "bg-blue-100 text-blue-800"],
  DELIVERED: ["delivered (receipt)", "bg-green-100 text-green-800"],
  FAILED: ["failed", "bg-red-100 text-red-800"],
  UNKNOWN: ["delivery unknown", "bg-amber-100 text-amber-900"],
};

/** Delivery state with its evidence level spelled out. */
export function DeliveryBadge({ state }: { state: string }) {
  const [label, cls] = DELIVERY[state] ?? [state, ""];
  return <span className={`badge ${cls}`} title="Delivered is only shown with an independent receipt">{label}</span>;
}

export function StatusBadge({ status }: { status: string }) {
  return <span className="badge bg-slate-100 text-slate-700">{status.replace(/_/g, " ").toLowerCase()}</span>;
}
