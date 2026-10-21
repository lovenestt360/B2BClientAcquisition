"use client";

import { useState, useTransition } from "react";
import { dialAction } from "@/app/actions/outreach";

export function DialButton({ callId, label }: { callId: string; label: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  return (
    <div className="space-y-1">
      <button
        type="button"
        className="btn-primary w-full sm:w-auto"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await dialAction(callId);
            if (!r.ok) return setError(r.error);
            setUrl(r.data!.url);
            setNote(r.data!.note ?? null);
            window.location.href = r.data!.url;
          })
        }
      >
        📞 {label}
      </button>
      {note && <p className="text-xs text-violet-700">{note}</p>}
      {url && <p className="text-xs text-slate-500">Phone didn&apos;t open? <a className="text-brand-700 underline" href={url}>Tap here</a>.</p>}
      {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
    </div>
  );
}
