import { env } from "@/lib/env";

export interface SttResult {
  text: string;
  language?: string;
}
export interface SttClient {
  readonly name: string;
  transcribe(audio: Buffer, mime: string): Promise<SttResult>;
}
export interface TtsClient {
  readonly name: string;
  /** Returns null when the client cannot synthesise (the browser then falls back to its own TTS). */
  synthesize(text: string, opts?: { voiceRef?: string | null }): Promise<{ audio: Buffer; mime: string } | null>;
}

/** faster-whisper service (voice-services/stt). */
export class HttpSttClient implements SttClient {
  readonly name = "faster-whisper";
  constructor(private url: string) {}
  async transcribe(audio: Buffer, mime: string) {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(audio)], { type: mime }), "audio");
    const res = await fetch(`${this.url}/transcribe`, { method: "POST", body: form, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`STT error ${res.status}`);
    return (await res.json()) as SttResult;
  }
}

/** Chatterbox TTS service (voice-services/tts). */
export class HttpTtsClient implements TtsClient {
  readonly name = "chatterbox";
  constructor(private url: string) {}
  async synthesize(text: string, opts: { voiceRef?: string | null } = {}) {
    const res = await fetch(`${this.url}/synthesize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, voice_ref: opts.voiceRef ?? null }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`TTS error ${res.status}`);
    return { audio: Buffer.from(await res.arrayBuffer()), mime: res.headers.get("content-type") ?? "audio/wav" };
  }
}

/** Mock STT: treats the payload as UTF-8 text (used by tests and the text-input sandbox). */
export class MockSttClient implements SttClient {
  readonly name = "mock";
  async transcribe(audio: Buffer) {
    return { text: audio.toString("utf8").trim() };
  }
}

export class MockTtsClient implements TtsClient {
  readonly name = "mock";
  async synthesize() {
    return null;
  }
}

export function getStt(): SttClient {
  const e = env();
  return e.STT_PROVIDER === "http" ? new HttpSttClient(e.STT_URL) : new MockSttClient();
}
export function getTts(): TtsClient {
  const e = env();
  return e.TTS_PROVIDER === "http" ? new HttpTtsClient(e.TTS_URL) : new MockTtsClient();
}
