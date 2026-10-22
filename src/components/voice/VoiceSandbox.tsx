"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Action =
  | { type: "speak"; text: string; seq: number; audioBase64?: string; audioMime?: string }
  | { type: "stop_speaking" }
  | { type: "start_silence_timer"; ms: number }
  | { type: "transfer_to_human" }
  | { type: "end_call"; reason: string };

interface Brief {
  firstName: string;
  lastName: string | null;
  title: string | null;
  company: string | null;
  industry: string | null;
  angle: string;
  pitch: string;
  discoveryQuestions: string[];
  facts: { field: string; value: string; sourceUrl: string }[];
  history: string[];
  generatedBy: string;
}

interface Resp {
  callId: string;
  phase: string;
  actions: Action[];
  transcript: { seq: number; speaker: string; text: string; interrupted: boolean }[];
  silenceTimeoutMs: number;
  brief?: Brief;
  booking?: { startIso: string; label: string; status: string };
  error?: string;
}

const SPEECH_RMS = 0.04; // raise while the agent is speaking to avoid echo-triggered barge-in
const SPEECH_RMS_WHILE_AGENT = 0.09;
const MIN_SPEECH_MS = 250;
const END_SILENCE_MS = 900;

export function VoiceSandbox({
  agents,
  leads,
  sttEnabled,
  ttsEnabled,
}: {
  agents: { id: string; name: string }[];
  leads: { id: string; label: string }[];
  sttEnabled: boolean;
  ttsEnabled: boolean;
}) {
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [leadId, setLeadId] = useState(leads[0]?.id ?? "");
  const [brief, setBrief] = useState<Brief | null>(null);
  const [booking, setBooking] = useState<Resp["booking"] | null>(null);
  const [callId, setCallId] = useState<string | null>(null);
  const [phase, setPhase] = useState("idle");
  const [transcript, setTranscript] = useState<Resp["transcript"]>([]);
  const [speaking, setSpeaking] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [micOn, setMicOn] = useState(false);

  const callRef = useRef<string | null>(null);
  const speakingRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const silenceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const epoch = useRef(0); // invalidates callbacks from interrupted playback
  const busy = useRef<Promise<void>>(Promise.resolve());
  const mic = useRef<{ stream: MediaStream; ctx: AudioContext; raf: number } | null>(null);

  const clearSilence = () => {
    if (silenceRef.current) clearTimeout(silenceRef.current);
    silenceRef.current = null;
  };

  const stopAudio = () => {
    epoch.current++;
    audioRef.current?.pause();
    audioRef.current = null;
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    speakingRef.current = false;
    setSpeaking(false);
  };

  // Serialise requests so events reach the engine in order.
  const send = useCallback((event: Record<string, unknown>, path = "event", body?: Blob) => {
    clearSilence();
    busy.current = busy.current.then(async () => {
      const id = callRef.current;
      if (!id) return;
      const res = await fetch(`/api/voice/sandbox/${id}/${path}`, {
        method: "POST",
        headers: { "content-type": body ? body.type || "audio/webm" : "application/json" },
        body: body ?? JSON.stringify(event),
      });
      const data = (await res.json()) as Resp;
      if (!res.ok) return setError(data.error ?? "Request failed");
      apply(data);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const play = (a: Extract<Action, { type: "speak" }>) => {
    const my = ++epoch.current;
    speakingRef.current = true;
    setSpeaking(true);
    const done = () => {
      if (my !== epoch.current) return; // interrupted
      speakingRef.current = false;
      setSpeaking(false);
      send({ type: "agent_playback_finished" });
    };
    if (a.audioBase64) {
      const el = new Audio(`data:${a.audioMime ?? "audio/wav"};base64,${a.audioBase64}`);
      audioRef.current = el;
      el.onended = done;
      el.onerror = done;
      void el.play().catch(done);
    } else if (typeof speechSynthesis !== "undefined") {
      const u = new SpeechSynthesisUtterance(a.text);
      u.lang = "en-ZA";
      u.onend = done;
      u.onerror = done;
      speechSynthesis.speak(u);
    } else {
      setTimeout(done, Math.min(6000, 60 * a.text.length));
    }
  };

  function apply(r: Resp) {
    setTranscript(r.transcript);
    if (r.brief) setBrief(r.brief);
    if (r.booking) setBooking(r.booking);
    setPhase(r.phase);
    for (const a of r.actions) {
      if (a.type === "speak") play(a);
      else if (a.type === "stop_speaking") stopAudio();
      else if (a.type === "start_silence_timer") {
        clearSilence();
        silenceRef.current = setTimeout(() => send({ type: "silence_timeout" }), a.ms);
      } else if (a.type === "transfer_to_human") setStatus("Handed over to a human (simulated).");
      else if (a.type === "end_call") {
        setStatus(`Call ended: ${a.reason.replace(/_/g, " ")}`);
        stopMic();
      }
    }
  }

  const start = async () => {
    setError(null);
    setStatus(null);
    setTranscript([]);
    setBrief(null);
    setBooking(null);
    const res = await fetch("/api/voice/sandbox", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ voiceAgentId: agentId, contactId: leadId || null }),
    });
    const data = (await res.json()) as Resp;
    if (!res.ok) return setError(data.error ?? "Could not start");
    callRef.current = data.callId;
    setCallId(data.callId);
    apply(data);
  };

  const bargeIn = () => {
    clearSilence();
    if (speakingRef.current) {
      stopAudio();
      send({ type: "user_speech_started" });
    }
  };

  const submitText = (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    bargeIn();
    send({ type: "user_utterance", text });
    setText("");
  };

  // ── Microphone with simple energy VAD (headphones recommended) ──
  const startMic = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      let speechSince = 0;
      let quietSince = 0;
      let recorder: MediaRecorder | null = null;
      let chunks: Blob[] = [];
      const tick = () => {
        analyser.getFloatTimeDomainData(buf);
        const rms = Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length);
        const now = performance.now();
        const loud = rms > (speakingRef.current ? SPEECH_RMS_WHILE_AGENT : SPEECH_RMS);
        if (loud) {
          quietSince = 0;
          speechSince ||= now;
          if (!recorder && now - speechSince > MIN_SPEECH_MS) {
            bargeIn();
            chunks = [];
            recorder = new MediaRecorder(stream);
            recorder.ondataavailable = (ev) => chunks.push(ev.data);
            recorder.onstop = () => {
              const blob = new Blob(chunks, { type: recorder?.mimeType || "audio/webm" });
              if (blob.size > 0) send({}, "audio", blob);
            };
            recorder.start();
          }
        } else {
          speechSince = 0;
          quietSince ||= now;
          if (recorder && now - quietSince > END_SILENCE_MS) {
            recorder.stop();
            recorder = null;
          }
        }
        if (mic.current) mic.current.raf = requestAnimationFrame(tick);
      };
      mic.current = { stream, ctx, raf: requestAnimationFrame(tick) };
      setMicOn(true);
    } catch {
      setError("Microphone permission denied or unavailable.");
    }
  };

  function stopMic() {
    if (!mic.current) return;
    cancelAnimationFrame(mic.current.raf);
    mic.current.stream.getTracks().forEach((t) => t.stop());
    void mic.current.ctx.close();
    mic.current = null;
    setMicOn(false);
  }

  useEffect(() => () => {
    stopMic();
    stopAudio();
    clearSilence();
  }, []);

  const live = callId && phase !== "ended" && phase !== "human_takeover";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1">
          <label className="label" htmlFor="lead">Lead to call</label>
          <select id="lead" className="input" value={leadId} onChange={(e) => setLeadId(e.target.value)} disabled={!!live}>
            <option value="">No lead (generic conversation)</option>
            {leads.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
        </div>
        <div className="min-w-0 flex-1">
          <label className="label" htmlFor="agent">Voice agent</label>
          <select id="agent" className="input" value={agentId} onChange={(e) => setAgentId(e.target.value)} disabled={!!live}>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
        {!live ? (
          <button className="btn-primary" onClick={start} disabled={!agentId}>Start simulated call</button>
        ) : (
          <>
            <button className="btn-secondary" onClick={() => send({ type: "human_takeover" })}>Human takeover</button>
            <button className="btn-danger" onClick={() => { stopAudio(); send({ type: "emergency_hangup" }); }}>Emergency hang-up</button>
          </>
        )}
      </div>

      <div className="flex flex-wrap gap-2 text-xs">
        <span className="badge bg-violet-100 text-violet-800">Simulated: no phone network</span>
        <span className="badge bg-slate-100">phase: {phase}</span>
        {speaking && <span className="badge bg-green-100 text-green-800">agent speaking…</span>}
        <span className="badge bg-slate-100">TTS: {ttsEnabled ? "Chatterbox" : "browser voice (mock)"}</span>
        <span className="badge bg-slate-100">STT: {sttEnabled ? "faster-whisper" : "type replies (mock)"}</span>
      </div>

      {booking && (
        <p className="rounded-lg bg-green-50 p-3 text-sm text-green-900" role="status" data-testid="sandbox-booking">
          🗓️ Meeting booked: <strong>{booking.label}</strong>
          {booking.status === "simulated" && " (rehearsal: saved as simulated, not added to your diary)"}
        </p>
      )}
      {brief && (
        <details className="rounded-lg border border-slate-200 bg-white p-3 text-sm" open data-testid="sandbox-brief">
          <summary className="cursor-pointer font-medium">
            Lead brief: {brief.firstName} {brief.lastName ?? ""}{brief.title ? `, ${brief.title}` : ""}{brief.company ? ` at ${brief.company}` : ""} <span className="text-xs text-slate-500">({brief.generatedBy})</span>
          </summary>
          <p className="mt-2"><strong>Angle:</strong> {brief.angle}</p>
          <p className="mt-1"><strong>Pitch:</strong> {brief.pitch}</p>
          <p className="mt-1"><strong>Discovery:</strong> {brief.discoveryQuestions.join(" · ")}</p>
          {brief.facts.length > 0 && (
            <ul className="mt-1 list-disc pl-5 text-xs">
              {brief.facts.map((f, i) => <li key={i}>{f.field.replace(/_/g, " ")}: {f.value} <a className="text-brand-700 underline" href={f.sourceUrl} target="_blank" rel="noreferrer">source</a></li>)}
            </ul>
          )}
          {brief.history.length > 0 && <ul className="mt-1 list-disc pl-5 text-xs text-slate-600">{brief.history.map((h, i) => <li key={i}>{h}</li>)}</ul>}
        </details>
      )}

      <div className="card max-h-96 space-y-2 overflow-y-auto" aria-live="polite" data-testid="sandbox-transcript">
        {transcript.length === 0 && <p className="muted">Start a call. The agent opens by saying it is an AI.</p>}
        {transcript.map((t) => (
          <div key={t.seq} className={`flex ${t.speaker === "human" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${t.speaker === "human" ? "bg-brand-600 text-white" : t.speaker === "system" ? "bg-slate-50 text-xs italic" : "bg-slate-100"}`}>
              {t.text}
              {t.interrupted && <span className="ml-1 text-[10px] text-amber-700">(interrupted)</span>}
            </div>
          </div>
        ))}
      </div>

      {live && (
        <div className="space-y-2">
          <form onSubmit={submitText} className="flex gap-2">
            <input
              className="input"
              value={text}
              onChange={(e) => {
                if (!text && e.target.value) bargeIn(); // typing while the agent talks = interruption
                setText(e.target.value);
              }}
              placeholder="Type what the prospect says…"
              aria-label="Your reply"
            />
            <button className="btn-primary">Say</button>
          </form>
          {sttEnabled && (
            <button className="btn-secondary" onClick={micOn ? stopMic : startMic}>{micOn ? "Stop microphone" : "Use microphone (headphones recommended)"}</button>
          )}
        </div>
      )}
      {status && <p className="text-sm text-slate-700" role="status">{status}</p>}
      {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
    </div>
  );
}
