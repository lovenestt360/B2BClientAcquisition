"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AssistView } from "@/server/voice/assist";
import { ActionForm } from "@/components/ActionForm";
import { DialButton } from "@/components/outreach/DialButton";
import { callOutcomeAction } from "@/app/actions/outreach";

type Speaker = "caller" | "lead" | "auto";

const STAGES: [AssistView["stage"], string][] = [
  ["opener", "Opener"],
  ["discovery", "Pain point"],
  ["pitch", "Solution & outcome"],
  ["meeting_ask", "Meeting ask"],
  ["booked", "Booked"],
  ["callback", "Call back"],
  ["closed_no", "Not interested"],
];

const SPEECH_RMS = 0.03;
const MIN_SPEECH_MS = 250;
const END_SILENCE_MS = 800;
const MAX_SEGMENT_MS = 15_000;

/**
 * Energy VAD: records one speech segment at a time from a stream and hands it over.
 * Returns a stop function. Audio never leaves the browser except as segments for transcription.
 */
function startVad(stream: MediaStream, onSegment: (blob: Blob, heldSpace: boolean) => void, spaceHeld: () => boolean) {
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  let speechSince = 0;
  let quietSince = 0;
  let startedAt = 0;
  let held = false;
  let recorder: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let raf = 0;
  const stopRecorder = () => {
    if (!recorder) return;
    recorder.stop();
    recorder = null;
  };
  const tick = () => {
    analyser.getFloatTimeDomainData(buf);
    const rms = Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length);
    const now = performance.now();
    if (recorder && spaceHeld()) held = true;
    if (rms > SPEECH_RMS) {
      quietSince = 0;
      speechSince ||= now;
      if (!recorder && now - speechSince > MIN_SPEECH_MS) {
        chunks = [];
        held = spaceHeld();
        startedAt = now;
        const r = new MediaRecorder(stream);
        const wasHeld = () => held;
        r.ondataavailable = (ev) => chunks.push(ev.data);
        r.onstop = () => {
          const blob = new Blob(chunks, { type: r.mimeType || "audio/webm" });
          if (blob.size > 0) onSegment(blob, wasHeld());
        };
        r.start();
        recorder = r;
      }
    } else {
      speechSince = 0;
      quietSince ||= now;
      if (recorder && now - quietSince > END_SILENCE_MS) stopRecorder();
    }
    if (recorder && now - startedAt > MAX_SEGMENT_MS) stopRecorder();
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(raf);
    stopRecorder();
    void ctx.close();
  };
}

export function LiveCallAssist({
  callId,
  initial,
  lead,
  sources,
  sttEnabled,
  outcomes,
  suggestedOutcome,
}: {
  callId: string;
  initial: AssistView | null;
  lead: { name: string; company: string | null; phone: string | null; isSimulated: boolean };
  sources: { speakerphone: boolean; softphone: boolean };
  sttEnabled: boolean;
  outcomes: string[][];
  suggestedOutcome: string;
}) {
  const [v, setV] = useState<AssistView | null>(initial);
  const [source, setSource] = useState<"speakerphone" | "softphone">(initial?.source ?? (sources.speakerphone ? "speakerphone" : "softphone"));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [listening, setListening] = useState(false);
  const [spaceDown, setSpaceDown] = useState(false);
  const [phone, setPhone] = useState<"idle" | "connecting" | "ringing" | "in_call" | "ended">("idle");
  const [text, setText] = useState("");
  const [typedSpeaker, setTypedSpeaker] = useState<"lead" | "caller">("lead");
  const [inflight, setInflight] = useState(0);

  const spaceRef = useRef(false);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const vads = useRef<(() => void)[]>([]);
  const micStream = useRef<MediaStream | null>(null);
  const remoteStream = useRef<MediaStream | null>(null);
  const remoteAudio = useRef<HTMLAudioElement | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sip = useRef<{ ua: any; session: any } | null>(null);
  const transcriptEnd = useRef<HTMLDivElement | null>(null);

  // Requests are serialised so the script sees utterances in order.
  const post = useCallback((path: string, body: BodyInit, contentType: string) => {
    setInflight((n) => n + 1);
    queue.current = queue.current.then(async () => {
      try {
        const res = await fetch(`/api/voice/assist/${callId}${path}`, { method: "POST", headers: { "content-type": contentType }, body });
        const data = (await res.json()) as AssistView & { error?: string };
        if (!res.ok) setError(data.error ?? "Request failed");
        else {
          setError(null);
          setV(data);
        }
      } catch {
        setError("Network error");
      } finally {
        setInflight((n) => n - 1);
      }
    });
    return queue.current;
  }, [callId]);

  const event = useCallback((e: Record<string, unknown>) => post("", JSON.stringify(e), "application/json"), [post]);

  // Background AI steps run outside the queue so they never hold up the next utterance. A reply is
  // applied only if it isn't older than what's on screen (suggestion ids only increase).
  const background = useCallback(async (type: "refine" | "refine_summary") => {
    try {
      const res = await fetch(`/api/voice/assist/${callId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type }) });
      const data = (await res.json()) as AssistView & { error?: string };
      if (!res.ok) return;
      setV((cur) => {
        if (!cur || data.suggestion.id > cur.suggestion.id) return data;
        if (data.suggestion.id === cur.suggestion.id && data.transcript.length >= cur.transcript.length) return data;
        return cur;
      });
    } catch {
      /* the rule-based line stays */
    }
  }, [callId]);
  const refinedFor = useRef(-1);
  const summaryAsked = useRef(false);
  useEffect(() => {
    if (!v?.refinePending || refinedFor.current === v.suggestion.id) return;
    refinedFor.current = v.suggestion.id;
    void background("refine");
  }, [v?.refinePending, v?.suggestion.id, background]);
  useEffect(() => {
    if (!v?.summaryPending || summaryAsked.current) return;
    summaryAsked.current = true;
    void background("refine_summary");
  }, [v?.summaryPending, background]);
  const segment = useCallback((blob: Blob, speaker: Speaker) => post(`/audio?speaker=${speaker}`, blob, blob.type || "audio/webm"), [post]);

  const start = async () => {
    setPending(true);
    setError(null);
    const res = await fetch(`/api/voice/assist/${callId}/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source }) });
    const data = (await res.json()) as AssistView & { error?: string };
    setPending(false);
    if (!res.ok) return setError(data.error ?? "Could not start");
    setV(data);
  };

  // ── Listening ──
  const stopListening = useCallback(() => {
    vads.current.forEach((stop) => stop());
    vads.current = [];
    if (sip.current === null) {
      micStream.current?.getTracks().forEach((t) => t.stop());
      micStream.current = null;
    }
    setListening(false);
  }, []);

  const startListening = async () => {
    if (!v?.consent.canTranscribe) return;
    try {
      if (v.source === "softphone") {
        if (!micStream.current || !remoteStream.current) return setError("Connect the softphone call first.");
        vads.current.push(startVad(micStream.current, (b) => void segment(b, "caller"), () => false));
        vads.current.push(startVad(remoteStream.current, (b) => void segment(b, "lead"), () => false));
      } else {
        // The iPhone on speaker and your voice reach the same laptop mic.
        micStream.current = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true } });
        vads.current.push(startVad(micStream.current, (b, held) => void segment(b, held ? "caller" : "auto"), () => spaceRef.current));
      }
      setListening(true);
    } catch {
      setError("Microphone permission denied or unavailable.");
    }
  };

  // Hold Space (outside text fields) to mark a speakerphone segment as yours.
  useEffect(() => {
    const isField = (t: EventTarget | null) => t instanceof HTMLElement && ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName);
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || isField(e.target)) return;
      e.preventDefault();
      spaceRef.current = true;
      setSpaceDown(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      spaceRef.current = false;
      setSpaceDown(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  // ── Softphone (JsSIP over WSS) ──
  const hangUp = useCallback(() => {
    try {
      sip.current?.session?.terminate();
    } catch {
      /* already ended */
    }
    try {
      sip.current?.ua?.stop();
    } catch {
      /* already stopped */
    }
    sip.current = null;
    micStream.current?.getTracks().forEach((t) => t.stop());
    micStream.current = null;
    remoteStream.current = null;
    setPhone("ended");
  }, []);

  const dialSoftphone = async () => {
    if (!v?.dialTarget) return;
    setError(null);
    setPhone("connecting");
    try {
      const cfgRes = await fetch("/api/voice/softphone");
      const cfg = (await cfgRes.json()) as { wssUrl: string; uri: string; password: string; displayName: string | null; error?: string };
      if (!cfgRes.ok) throw new Error(cfg.error ?? "Softphone unavailable");
      const JsSIP = (await import("jssip")).default;
      const ua = new JsSIP.UA({
        sockets: [new JsSIP.WebSocketInterface(cfg.wssUrl)],
        uri: cfg.uri,
        password: cfg.password,
        display_name: cfg.displayName ?? undefined,
        register: false,
      });
      ua.start();
      micStream.current = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const session = ua.call(v.dialTarget, {
        mediaStream: micStream.current,
        pcConfig: { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] },
      });
      sip.current = { ua, session };
      session.connection.addEventListener("track", (e: RTCTrackEvent) => {
        remoteStream.current = e.streams[0] ?? new MediaStream([e.track]);
        if (remoteAudio.current) {
          remoteAudio.current.srcObject = remoteStream.current;
          void remoteAudio.current.play().catch(() => undefined);
        }
      });
      session.on("progress", () => setPhone("ringing"));
      session.on("confirmed", () => setPhone("in_call"));
      session.on("ended", () => { stopListening(); hangUp(); });
      session.on("failed", (e: { cause?: string }) => {
        setError(`Call failed: ${e.cause ?? "unknown"}`);
        stopListening();
        hangUp();
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Softphone error");
      hangUp();
    }
  };

  useEffect(() => () => { stopListening(); hangUp(); }, [stopListening, hangUp]);
  useEffect(() => { transcriptEnd.current?.scrollIntoView({ block: "nearest" }); }, [v?.transcript.length]);

  const submitText = (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    void event({ type: "utterance", speaker: typedSpeaker, text, origin: "typed" });
    setText("");
  };

  const finish = async () => {
    stopListening();
    if (sip.current) hangUp();
    await event({ type: "finish" });
  };

  // ── Not started yet ──
  if (!v) {
    return (
      <section className="card max-w-xl space-y-3">
        <h2 className="font-semibold">How are you calling?</h2>
        <label className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${!sources.speakerphone ? "opacity-50" : ""}`}>
          <input type="radio" name="source" checked={source === "speakerphone"} disabled={!sources.speakerphone} onChange={() => setSource("speakerphone")} />
          <span><strong>iPhone on speaker</strong><br /><span className="text-slate-600">You dial from your iPhone and put it on speaker next to the laptop. The laptop microphone hears the room; the platform never taps the iPhone.</span></span>
        </label>
        <label className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${!sources.softphone ? "opacity-50" : ""}`}>
          <input type="radio" name="source" checked={source === "softphone"} disabled={!sources.softphone} onChange={() => setSource("softphone")} />
          <span><strong>Browser softphone</strong> {!sources.softphone && <em>(not enabled or SIP not configured)</em>}<br /><span className="text-slate-600">You call through your business SIP line in the browser (headset recommended). Both sides are heard separately, so the transcript knows who said what.</span></span>
        </label>
        <button className="btn-primary" onClick={start} disabled={pending || !(sources.speakerphone || sources.softphone)}>{pending ? "Preparing script…" : "Start live assist"}</button>
        {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
      </section>
    );
  }

  const stageIdx = STAGES.findIndex(([s]) => s === v.stage);
  const consentDone = v.consent.canTranscribe || !!v.consent.refusedAt;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="space-y-3">
        {/* Phone controls */}
        <section className="card flex flex-wrap items-center gap-2 text-sm">
          {v.source === "speakerphone" ? (
            <>
              {!v.finished && <DialButton callId={callId} label={`Call ${lead.name} on iPhone`} />}
              <span className="muted">Put the iPhone on speaker, close to the laptop.</span>
            </>
          ) : v.dialTarget ? (
            <>
              {(phone === "idle" || phone === "ended") && !v.finished && <button className="btn-primary" onClick={dialSoftphone}>📞 Call {lead.name}</button>}
              {(phone === "connecting" || phone === "ringing" || phone === "in_call") && <button className="btn-danger" onClick={() => { stopListening(); hangUp(); }}>Hang up</button>}
              <span className="badge bg-slate-100">{phone.replace("_", " ")}</span>
              <audio ref={remoteAudio} autoPlay />
            </>
          ) : (
            <span className="text-violet-700">Dummy lead: nothing is dialled. Rehearse by typing both sides.</span>
          )}
          {lead.phone && <span className="font-mono">{lead.phone}</span>}
        </section>

        {/* Consent */}
        {!consentDone && !v.finished && (
          <section className="card space-y-2 border-amber-300 bg-amber-50 text-sm" data-testid="assist-consent">
            <p className="font-medium">Before the AI listens, say:</p>
            <p className="rounded bg-white p-2 text-base">“{v.consent.line}”</p>
            <div className="flex flex-wrap gap-2">
              {v.consent.rule === "disclose" ? (
                <button className="btn-primary" onClick={() => event({ type: "consent", answer: "told" })}>I told them</button>
              ) : (
                <button className="btn-primary" onClick={() => event({ type: "consent", answer: "agreed" })}>They agreed</button>
              )}
              <button className="btn-secondary" onClick={() => event({ type: "consent", answer: "refused" })}>They objected (no transcription)</button>
            </div>
            <p className="text-xs text-amber-900">
              {v.consent.rule === "disclose" ? "South African lead: telling them is required before transcribing." : "Lead outside South Africa (or country unknown): they must agree before anything is transcribed."}
            </p>
          </section>
        )}

        {v.optOut && (
          <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">The lead asked not to be contacted. Confirm it, end the call, and save the outcome as “Asked not to be contacted”.</p>
        )}

        {/* Stage rail */}
        <nav className="flex flex-wrap gap-1" aria-label="Call stage">
          {STAGES.map(([s, label], i) => (
            <button
              key={s}
              disabled={v.finished || s === "booked" || v.stage === "opt_out"}
              onClick={() => event({ type: "stage", stage: s })}
              className={`rounded-full border px-3 py-1 text-xs ${s === v.stage ? "border-brand-600 bg-brand-600 text-white" : i < stageIdx && stageIdx <= 4 ? "border-brand-200 bg-brand-50 text-brand-700" : "border-slate-200 bg-white text-slate-600"}`}
            >
              {label}
            </button>
          ))}
        </nav>

        {/* Say next */}
        <section className="card space-y-2 border-2 border-brand-600" aria-live="polite" data-testid="assist-suggestion">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span className="font-semibold uppercase tracking-wide text-brand-700">Say next</span>
            <span>{inflight > 0 ? "transcribing…" : v.refinePending ? "AI is polishing this line…" : v.suggestion.generatedBy.startsWith("rules") ? "script" : "AI-worded"}</span>
          </div>
          <p className="text-xl leading-snug">{v.suggestion.say}</p>
          <p className="text-sm text-slate-600">💡 {v.suggestion.why}</p>
          {v.suggestion.alternatives.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer text-slate-600">Other ways to say it</summary>
              <ul className="mt-1 list-disc pl-5">{v.suggestion.alternatives.map((a, i) => <li key={i}>{a}</li>)}</ul>
            </details>
          )}
          {v.agreedSlot && !v.booked && (
            <button className="btn-primary" onClick={() => event({ type: "book" })} data-testid="assist-book">🗓️ Book {v.agreedSlot.label}</button>
          )}
          {v.booked && (
            <p className="rounded bg-green-50 p-2 text-sm text-green-900" role="status">
              🗓️ Meeting booked: <strong>{v.booked.label}</strong> ({v.booked.status === "simulated" ? "dummy lead: not in your diary" : v.booked.status})
            </p>
          )}
          {v.offered.length > 0 && !v.booked && <p className="text-xs text-slate-500">Free slots offered: {v.offered.map((o) => o.label).join(" · ")}</p>}
        </section>

        {/* Listening + typing */}
        {!v.finished && (
          <section className="card space-y-2 text-sm">
            {sttEnabled ? (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  className={listening ? "btn-secondary" : "btn-primary"}
                  disabled={!v.consent.canTranscribe}
                  onClick={listening ? stopListening : startListening}
                >
                  {listening ? "⏸ Stop listening" : "🎙 Start listening"}
                </button>
                {listening && v.source === "speakerphone" && (
                  <span className={`badge ${spaceDown ? "bg-brand-600 text-white" : "bg-slate-100"}`}>{spaceDown ? "marking as you" : "hold Space while you speak"}</span>
                )}
                {!v.consent.canTranscribe && <span className="muted">{v.consent.refusedAt ? "Transcription declined: type key points instead." : "Waiting for the transcription notice."}</span>}
              </div>
            ) : (
              <p className="muted">Speech recognition is off (STT_PROVIDER=mock). Type what the lead says.</p>
            )}
            <form onSubmit={submitText} className="flex gap-2">
              <select className="input w-auto" value={typedSpeaker} onChange={(e) => setTypedSpeaker(e.target.value as "lead" | "caller")} aria-label="Who said it">
                <option value="lead">Lead said</option>
                <option value="caller">I said</option>
              </select>
              <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Type what was said…" aria-label="What was said" />
              <button className="btn-secondary">Add</button>
            </form>
            <button className="btn-danger" onClick={finish}>End call & summarise</button>
          </section>
        )}

        {error && <p className="text-sm text-red-600" role="alert">{error}</p>}

        {/* After the call */}
        {v.finished && (
          <section className="card space-y-3 text-sm" data-testid="assist-summary">
            <h2 className="font-semibold">Meeting prep</h2>
            {v.summary ? (
              <>
                <p><strong>Next step:</strong> {v.summary.nextStep}</p>
                <List title="Pain points" items={v.summary.painPoints} empty="None captured." />
                <List title="Project details mentioned" items={v.summary.projectHints} />
                <List title="Collect in the meeting: technical" items={v.summary.meetingPrep.technical} />
                <List title="Collect in the meeting: financial" items={v.summary.meetingPrep.financial} />
                <p className="text-xs text-slate-500">
                  {v.summaryPending ? "AI is reading the transcript to improve this (about a minute on the laptop)… " : `(${v.summary.generatedBy}) `}
                  {v.booked ? "Also saved on the meeting's notes." : ""}
                </p>
              </>
            ) : (
              <p className="muted">Summarising…</p>
            )}
            {v.status === "DIALING" ? (
              <ActionForm action={callOutcomeAction} submitLabel="Save outcome" className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
                <input type="hidden" name="callId" value={callId} />
                <select className="input" name="outcome" aria-label="Outcome" defaultValue={suggestedOutcome} required>
                  {outcomes.filter(([o]) => o !== "DID_NOT_CALL").map(([o, l]) => <option key={o} value={o}>{l}</option>)}
                </select>
                <input className="input" type="number" step="0.5" min="0" name="durationMin" placeholder="Duration (minutes, optional)" aria-label="Duration in minutes" />
                <textarea className="input" name="notes" rows={2} placeholder="Notes" aria-label="Notes" />
              </ActionForm>
            ) : (
              <p className="text-green-700">Outcome saved. <Link className="underline" href="/calls">Back to the call queue</Link></p>
            )}
          </section>
        )}
      </div>

      <aside className="space-y-3">
        <section className="card text-sm">
          <h2 className="font-semibold">{lead.name}{lead.company ? ` · ${lead.company}` : ""}</h2>
          {v.brief.title && <p className="text-slate-600">{v.brief.title}{v.brief.industry ? ` · ${v.brief.industry}` : ""}</p>}
          <p className="mt-1"><strong>Angle:</strong> {v.brief.angle}</p>
          {v.brief.facts.length > 0 && (
            <ul className="mt-1 list-disc pl-5 text-xs">
              {v.brief.facts.map((f, i) => <li key={i}>{f.field.replace(/_/g, " ")}: {f.value} <a className="text-brand-700 underline" href={f.sourceUrl} target="_blank" rel="noreferrer">source</a></li>)}
            </ul>
          )}
          {v.brief.history.length > 0 && <ul className="mt-1 list-disc pl-5 text-xs text-slate-600">{v.brief.history.map((h, i) => <li key={i}>{h}</li>)}</ul>}
        </section>

        <section className="card text-sm" data-testid="assist-pains">
          <h2 className="font-semibold">Pain points heard</h2>
          {v.painPoints.length ? <ul className="list-disc pl-5">{v.painPoints.map((p, i) => <li key={i}>{p}</li>)}</ul> : <p className="muted">They'll appear as the lead talks.</p>}
          {v.objections.length > 0 && <><h3 className="mt-2 font-medium">Objections</h3><ul className="list-disc pl-5">{v.objections.map((o, i) => <li key={i}>{o}</li>)}</ul></>}
        </section>

        <details className="card text-sm">
          <summary className="cursor-pointer font-semibold">Objection answers</summary>
          <ul className="mt-1 space-y-1">{v.brief.objections.map((o, i) => <li key={i}><em>{o.objection}</em>: {o.response}</li>)}</ul>
        </details>

        <section className="card max-h-[28rem] space-y-1 overflow-y-auto text-sm" aria-label="Transcript" data-testid="assist-transcript">
          <h2 className="font-semibold">Transcript</h2>
          {v.transcript.length === 0 && <p className="muted">Nothing yet.</p>}
          {v.transcript.map((t) => (
            <p key={t.seq}><strong className={t.speaker === "caller" ? "text-brand-700" : "text-slate-800"}>{t.speaker === "caller" ? "You" : "Lead"}:</strong> {t.text}</p>
          ))}
          <div ref={transcriptEnd} />
        </section>
      </aside>
    </div>
  );
}

function List({ title, items, empty }: { title: string; items: string[]; empty?: string }) {
  if (!items.length && !empty) return null;
  return (
    <div>
      <h3 className="font-medium">{title}</h3>
      {items.length ? <ul className="list-disc pl-5">{items.map((x, i) => <li key={i}>{x}</li>)}</ul> : <p className="muted">{empty}</p>}
    </div>
  );
}
