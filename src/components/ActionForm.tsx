"use client";

import { useActionState, type ReactNode } from "react";
import type { ActionResult } from "@/app/actions/util";

export function ActionForm({
  action,
  children,
  submitLabel,
  className = "space-y-3",
  encType,
}: {
  action: (prev: ActionResult | undefined, form: FormData) => Promise<ActionResult>;
  children: ReactNode;
  submitLabel: string;
  className?: string;
  encType?: string;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form action={formAction} className={className} encType={encType}>
      {children}
      {state && !state.ok && <p className="text-sm text-red-600" role="alert">{state.error}</p>}
      {state?.ok && state.message && <p className="text-sm text-green-700" role="status">{state.message}</p>}
      <button className="btn-primary" disabled={pending}>{pending ? "Working…" : submitLabel}</button>
    </form>
  );
}

export function Field({ label, name, type = "text", required, defaultValue, placeholder }: {
  label: string; name: string; type?: string; required?: boolean; defaultValue?: string; placeholder?: string;
}) {
  return (
    <div>
      <label className="label" htmlFor={name}>{label}{required && " *"}</label>
      <input className="input" id={name} name={name} type={type} required={required} defaultValue={defaultValue} placeholder={placeholder} />
    </div>
  );
}
