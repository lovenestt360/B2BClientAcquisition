"use client";

import { useState, useTransition } from "react";
import { confirmOutcomeAction, copyDraftAction, handOffAction } from "@/app/actions/outreach";
import { detectPlatform } from "./platform";

/**
 * Manual iPhone hand-off: Copy / Open in Messages, then the user reports what happened.
 * The platform never sends the SMS and never claims delivery.
 */
export function SmsHandoff({ draftId, body, status, simulated }: { draftId: string; body: string; status: string; simulated: boolean }) {
  const [pending, start] = useTransition();
  const [url, setUrl] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [handedOff, setHandedOff] = useState(status === "HANDED_OFF");

  const open = () =>
    start(async () => {
      setError(null);
      const r = await handOffAction(draftId, detectPlatform());
      if (!r.ok) return setError(r.error);
      setHandedOff(true);
      setNote(r.data?.note ?? null);
      if (r.data?.kind === "native_app" && r.data.url) {
        setUrl(r.data.url);
        window.location.href = r.data.url;
      }
    });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      void copyDraftAction(draftId);
    } catch {
      setError("Clipboard unavailable: select the text and copy it manually");
    }
  };

  const outcome = (o: "sent" | "failed" | "not_sent") =>
    start(async () => {
      const r = await confirmOutcomeAction(draftId, o);
      if (!r.ok) setError(r.error);
      else if (o === "not_sent") setHandedOff(false);
    });

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-secondary" onClick={copy}>{copied ? "Copied ✓" : "Copy message"}</button>
        <button type="button" className="btn-primary" onClick={open} disabled={pending}>
          {simulated ? "Open in Messages (test)" : "Open in Messages"}
        </button>
      </div>
      {note && <p className="text-xs text-violet-700">{note}</p>}
      {url && (
        <p className="text-xs text-slate-500">
          Messages didn&apos;t open? <a className="text-brand-700 underline" href={url}>Tap here</a>, or paste the copied text into a new message.
        </p>
      )}
      {handedOff && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-2" data-testid="confirm-outcome">
          <p className="mb-2 text-xs text-amber-900">
            After pressing Send in Messages, tell us what happened. We can&apos;t see your phone, so delivery will show as <strong>unknown</strong>.
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-primary" disabled={pending} onClick={() => outcome("sent")}>I sent it</button>
            <button type="button" className="btn-secondary" disabled={pending} onClick={() => outcome("failed")}>It failed (Not Delivered)</button>
            <button type="button" className="btn-secondary" disabled={pending} onClick={() => outcome("not_sent")}>I didn&apos;t send it</button>
          </div>
        </div>
      )}
      {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
    </div>
  );
}
