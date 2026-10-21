# Voice

Three voice providers share one `VoiceProvider` interface:

| Provider | What it is | Status |
|---|---|---|
| `iphone_manual_call` | You dial from the iPhone Phone app via a `tel:` link. The platform shows the lead profile and AI talking points, then records the outcome you enter. | Disabled until an admin enables it |
| `local_ai_sandbox` | The AI agent talks to you in your browser. No telephone network. | Enabled in simulation mode |
| `asterisk_sip_ai` | Future autonomous calling over an authorised business SIP trunk. | Disabled and gated |

**The platform never has access to native iPhone cellular call audio, and never records calls.**

## Conversation engine (`src/server/voice/engine.ts`)

The engine is transport-independent and its state is plain JSON. A transport feeds it events and
performs the actions it returns.

| Event | Behaviour |
|---|---|
| `start` | Speaks the agent's **AI disclosure** (required; a config without "AI" is rejected) |
| `agent_playback_finished` | → listening; starts the silence timer |
| `user_speech_started` while speaking | **Barge-in**: `stop_speaking`, the agent turn is marked `interrupted` |
| `user_utterance` | Backchannels ("mm-hmm") are ignored. Opt-out, "talk to a human", "are you a robot?" and goodbye are handled **deterministically**. Anything else goes to the LLM (≤ 2 sentences, never claims to be human) |
| `silence_timeout` | Reprompts up to `maxSilenceReprompts`, then hangs up politely |
| `human_takeover` | Stops audio and transfers to a human |
| `emergency_hangup` | Stops immediately; audited |

Model replies claiming to be human are discarded. LLM failure ends the call gracefully. Turns are
persisted to `call_transcripts` (with `interrupted`) and events to `call_events`.

## Local sandbox

1. Default (`LLM_PROVIDER=mock`, `STT_PROVIDER=mock`, `TTS_PROVIDER=mock`): you type the
   prospect's lines and the browser's own speech synthesis voices the agent. Typing while the agent
   speaks counts as a barge-in.
2. Full local stack: `docker compose --profile ai --profile voice up -d`, then:
   ```bash
   docker compose exec ollama ollama pull llama3.1:8b
   # .env: LLM_PROVIDER=ollama STT_PROVIDER=http TTS_PROVIDER=http
   ```
   The sandbox shows **Use microphone**. A browser energy-VAD detects speech (≥ 250 ms) for
   barge-in and end of utterance (900 ms of quiet). Each utterance is POSTed to faster-whisper and
   the reply is synthesised by Chatterbox. Use headphones to avoid echo-triggered barge-in. Raw
   audio isn't stored; only transcripts are.

### Your own voice (Chatterbox)

Put a clean ~10 s WAV of **your own voice** in `voice-services/tts/voices/` (git-ignored). Set the
file name as the agent's voice reference and tick the consent attestation. The app refuses a
reference without the attestation, and the TTS service refuses paths outside `voices/`. Cloned
voices still open with the AI disclosure.

Hardware: faster-whisper `small` runs on CPU (int8). Chatterbox is far faster on an NVIDIA GPU.
On CPU, expect several seconds per sentence.

## Future SIP calling (Asterisk ARI + externalMedia)

**Preconditions, all mandatory:**
1. A business SIP trunk from a licensed South African operator whose terms permit
   automated/AI calling, with written authorisation (record the reference on the Providers page).
2. `ALLOW_AUTOMATED_OUTREACH=true`, `asterisk_sip_ai` enabled.
3. Never connect the Telkom consumer SIM or iPhone to a PBX or GSM gateway. That's SIM-boxing,
   and the platform won't support it.

**Design** (`src/server/voice/sip/`):

```
ARI originate PJSIP/<trunk>/<e164> → Stasis app
   → mixing bridge ← externalMedia channel (RTP, slin16 @ 16 kHz, both directions)
media bridge process:
   RTP in  → 20 ms frames → streaming STT (faster-whisper, VAD) → ConversationEngine events
   engine "speak" → Chatterbox → resample to 16 kHz slin16 → RTP out (paced 20 ms)
   engine "stop_speaking" (barge-in) → flush the outbound RTP queue
human takeover → add operator endpoint to the bridge, remove externalMedia
emergency hang-up → DELETE /channels/{id}
per-call cost → trunk per-minute rate × billed duration → cost_entries + calls.costCents
```

Implemented now: `AriClient` (every request passes `assertCanAutomate()`; tested to make no
network call when blocked) and RTP parse/build/framing (tested). Still to build once a trunk
exists: the UDP media bridge process, streaming STT, and ARI event handling (WebSocket).
