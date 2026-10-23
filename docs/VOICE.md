# Voice

Four voice providers share one `VoiceProvider` interface:

| Provider | What it is | Status |
|---|---|---|
| `iphone_manual_call` | You dial from the iPhone Phone app via a `tel:` link. The platform shows the lead profile and AI talking points, then records the outcome you enter. | Disabled until an admin enables it |
| `sip_softphone` | You call from the browser over a business SIP/VoIP account (WebRTC/WSS, JsSIP). A human places every call. | Disabled until an admin enables it and `SIP_WSS_URL`, `SIP_URI`, `SIP_PASSWORD` are set |
| `local_ai_sandbox` | The AI agent talks to you in your browser. No telephone network. | Enabled in simulation mode |
| `asterisk_sip_ai` | Future autonomous calling over an authorised business SIP trunk. | Disabled and gated |

**The platform never has access to native iPhone cellular call audio, and never records calls.**
Live call assist (below) only transcribes what the laptop microphone or the browser softphone hears,
after you have told the lead, and discards the audio.

## Live call assist (you call, the AI writes your script)

Open a queued call and choose **Call with live assist** (`/calls/<id>/live`,
`src/server/voice/assist.ts`, script logic in `assist-script.ts`).

| Mode | How the AI hears the call | Who said what |
|---|---|---|
| iPhone on speaker | Laptop mic picks up you and the speakerphone | Approximate: a line that echoes your suggested script is "you"; hold **Space** while you speak to force it |
| Browser softphone | Your mic and the lead's audio are separate WebRTC streams | Exact |

Flow (stages and transitions in `states.ts` → `ASSIST_TRANSITIONS`):

```
opener ("who I am, why you, got two minutes?")
  ├─ yes/other → discovery: up to 2 questions, the lead's answers become pain points
  │                → pitch: mirror the pain point, sell the outcome
  │                → meeting_ask: "<len>-minute <format> where you walk me through the project,
  │                   and I come back with a technical and financial proposal. <A> or <B>?"
  │                → slot chosen → you press Book → booked (tentative meeting)
  ├─ busy → callback        ├─ no → one playbook objection answer + meeting ask (2 max) → closed_no
  └─ opt-out phrase (any stage) → opt_out (final)
```

- **Before listening:** you read the notice ("I use a note-taking tool that transcribes this call…").
  ZA leads: confirming you told them is enough. Elsewhere: the lead must agree. Audio posted before
  that is rejected without being transcribed. Typed notes always work.
- **Rules decide, the model words.** Stage, opt-outs, price answers (your pricing line only) and
  which slot was agreed are deterministic. Ollama only rewords the lead-in of the next line and
  extracts pain points; output containing numbers, links or contact details is dropped.
  `LLM_PROVIDER=mock` runs purely on the rules.
- **After the call:** *End call & summarise* writes pain points, project details mentioned and a
  checklist of what to collect in the meeting (technical: scope, systems, users, timeline, success
  criteria; financial: budget, cost of the problem, decision makers, procurement, payment
  structure). It is saved on the call and appended to the booked meeting's notes. You then save
  the outcome as usual (preselected from where the script ended).
- Speech segments use the same energy VAD as the sandbox and are posted to faster-whisper
  (`STT_PROVIDER=http`). Expect 1–3 s from end of sentence to new suggestion on a local GPU.

### Softphone setup

1. A business SIP/VoIP account or PBX extension with WebRTC over WSS (e.g. Asterisk `res_pjsip`
   with `webrtc=yes`, or a provider that offers WSS). Never a consumer SIM in a gateway.
2. Create a **dedicated outbound-only extension**: its password is handed to the browser.
3. Set `SIP_WSS_URL=wss://pbx.example.com:8089/ws`, `SIP_URI=sip:201@pbx.example.com`,
   `SIP_PASSWORD=…` (optional `SIP_DISPLAY_NAME`), then enable *Browser softphone* on Providers.
4. Use a headset. Dummy leads are never dialled.

## AI sales caller

The goal of a call is to **book a meeting**. Before each call the platform prepares, and freezes
for the whole call:

1. **Lead brief** (`sales/brief.ts`): name, role, company, industry, sourced research facts,
   past calls, email/SMS replies and CRM notes, plus an angle, opener, tailored pitch, discovery
   questions and objection answers. The model only rephrases your playbook for this lead. Briefs
   containing invented numbers, links or contact details fall back to the template.
2. **Playbook** (`/playbook`): your offer, value points, true proof points, what may be said
   about price, and the meeting length and format.
3. **Free slots** (`sales/availability.ts`): your bookable hours minus existing meetings and a
   buffer, with minimum notice, SA public holidays skipped.

Call flow (`engine.ts`, sales mode):

```
AI disclosure in your voice + opener + "Do you have two minutes?"
  ├─ busy        → skip to booking: offer two concrete slots
  ├─ no          → one respectful objection answer + slots (max 2 tries, then a polite goodbye)
  └─ yes/other   → 2 discovery questions → tailored pitch → "Would <A> or <B> work better?"
close: "the first one" / "Thursday at 10" → booked
       another time → "I can do Friday at 14:00. Shall I lock that in?" → yes → booked
       price question → your pricing line only; other questions → answer + re-offer
```

Deterministic rules (never the model) decide opt-outs, the AI-identity answer, human handover,
yes/no/busy, which slot was chosen, and when to stop asking. The model only words the
acknowledgements, pitch and objection answers, and falls back to your playbook text if it fails.
Bookings re-check the slot in a database transaction (`sales/booking.ts`). Sandbox rehearsals are
saved as **simulated** meetings that never block your diary or move a real lead.

### Real phone calls: what's needed

The brain is transport-independent. To place real calls it needs:

- **A lawful line.** A business SIP trunk or a programmable-voice provider with a South African
  number whose terms allow automated/AI calls. Never the Telkom consumer SIM.
- **A lawful audience.** Under POPIA s69 an AI that calls by itself is an "automatic calling
  machine". It may only call people who **opted in** or who are **existing customers** (with an
  opt-out). Cold leads without consent are called by you (iPhone + AI talking points); the AI
  calls those who said yes, asked for a callback, or are customers. `checkEligibility()`
  enforces this for `VOICE_AUTOMATED`.
- **A media server.** Vercel can't stream call audio. The voice pipeline (faster-whisper,
  Chatterbox with your voice, Ollama) runs on your own machine or VPS.

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
