# Architecture

## Principles

1. **Self-hosted, no new subscriptions.** Postgres, pg-boss, Ollama, faster-whisper and Chatterbox
   all run in Docker on your own hardware. Existing Hostinger mailboxes (SMTP/IMAP) and Google
   Calendar are integrated directly, with no middleware SaaS.
2. **Manual first, automation gated.** The production channel today is the user's own iPhone on a
   Telkom prepaid eSIM. The platform prepares, guides and records. A human sends each SMS and
   dials each call. Automated providers exist only as interfaces behind a three-part gate.
3. **Evidence-based state.** Workflow status (draft → approved → handed off → confirmed) is kept
   separate from delivery evidence (`NOT_ATTEMPTED / ATTEMPTED / ACCEPTED / DELIVERED / FAILED /
   UNKNOWN`). `DELIVERED` needs a receipt.
4. **Compliance is a precondition, not a report.** Every outreach action calls `checkEligibility()`.

## Components

```
┌────────────── Browser / iPhone Safari ──────────────┐
│ Next.js UI (responsive)  sms: / tel: hand-offs       │
│ Voice sandbox (mic, VAD barge-in, playback)          │
└───────────────┬──────────────────────────────────────┘
                │ server actions / JSON routes (session cookie, RBAC)
┌───────────────▼──────────────────────────────────────┐
│ Next.js server (src/app)  →  domain services (src/server)
│   auth · crm · import · compliance · messaging · voice · providers · jobs · reports
└──────┬────────────────┬───────────────┬──────────────┘
       │ Prisma         │ pg-boss        │ HTTP (internal network)
┌──────▼─────┐   ┌──────▼──────┐   ┌─────▼──────┬────────────┬────────────┐
│ PostgreSQL │◄──│ worker      │   │ Ollama     │ STT        │ TTS        │
│            │   │ (same image)│   │ (LLM)      │ faster-    │ Chatterbox │
└────────────┘   └─────────────┘   └────────────┘ whisper    └────────────┘
```

| Path | Responsibility |
|---|---|
| `src/server/auth` | bcrypt passwords, DB sessions (sha256-hashed token in cookie), lockout, RBAC (`ADMIN > MANAGER > OPERATOR > VIEWER`) |
| `src/server/audit.ts` | `audit()`: every state change writes `audit_logs` |
| `src/server/import` | CSV/XLSX parse → header mapping → validation → dedupe plan → idempotent commit |
| `src/server/crm` | contacts & companies, manual entry with duplicate guards |
| `src/server/compliance` | rule packs (ZA/strict), `checkEligibility()`, consent, suppression, emergency stop, sender identity |
| `src/server/providers` | provider interfaces, Telkom iPhone adapter, simulated adapters, gated future adapters, airtime ledger |
| `src/server/messaging` | SMS drafts, approval, hand-off, user-confirmed outcomes, manual replies, state machines |
| `src/server/voice` | manual call queue/outcomes, AI call guidance, conversation engine, sandbox, STT/TTS clients, SIP (ARI/RTP) scaffolding |
| `src/server/ai` | LLM client (Ollama or deterministic mock), SMS generation with invented-detail guardrails |
| `src/server/jobs` | pg-boss wrapper with `job_records` idempotency keys and retry policies; inline mode for dev/tests |

## Provider abstraction

```ts
interface MessagingProvider { key; capabilities; validateRecipient(e164); prepareSend(msg): SmsHandoff }
interface VoiceProvider     { key; capabilities; validateRecipient(e164); prepareCall(to): CallHandoff }
type SmsHandoff  = { kind: "native_app", url, copyText } | { kind: "submitted", providerMessageId, state }
type CallHandoff = { kind: "native_dialer", url } | { kind: "sandbox" } | { kind: "originated", providerCallId }
```

| Key | Adapter | Mode | Default |
|---|---|---|---|
| `iphone_manual_sms` | `TelkomPrepaidIPhoneAdapter` | MANUAL | disabled |
| `iphone_manual_call` | `TelkomPrepaidIPhoneAdapter` | MANUAL | disabled |
| `simulated_sms` | `SimulatedSmsAdapter` | SIMULATED | on in simulation; dummy leads only |
| `local_ai_sandbox` | `LocalAiSandboxAdapter` | SIMULATED | on in simulation |
| `business_sms_api` | `BusinessSmsApiAdapter` | AUTOMATED | disabled + gated |
| `android_sms_gateway` | `AndroidSmsGatewayAdapter` | AUTOMATED | disabled + gated |
| `asterisk_sip_ai` | `AsteriskSipAiAdapter` | AUTOMATED | disabled + gated |

**Automation gate** (`providers/gate.ts`), all required:
`ALLOW_AUTOMATED_OUTREACH=true` in env, provider `enabled`, and a recorded carrier/provider
authorisation reference. Adding a vendor means implementing `prepareSend`/`prepareCall`. The CRM,
campaign and compliance layers don't change.

`carrier_lines` models the physical line (Telkom prepaid eSIM in an iPhone). The manual SMS and
manual call providers both bill to it, and the airtime ledger hangs off it. It stores no SIM
provisioning secrets.

## State machines

**Message draft** (`messaging/states.ts`)

```
PENDING_APPROVAL ─approve─► APPROVED ─open Messages─► HANDED_OFF ─"I sent it"──► SENT_CONFIRMED
        │                     ▲                          │  ├─"It failed"──► SEND_FAILED ─► APPROVED (retry)
        └─reject─► REJECTED   └──────"I didn't send"─────┘  │
any unsent ─emergency stop / opt-out─► CANCELLED
```

**Delivery evidence**

| Event | Delivery state | Evidence |
|---|---|---|
| iPhone: user confirms sent | `UNKNOWN` | `user_attestation` |
| iPhone: user saw "Not Delivered" | `FAILED` | `user_attestation` |
| Provider API accepted | `ACCEPTED` | `system` |
| Provider DLR delivered | `DELIVERED` | `provider_receipt` (only path to DELIVERED) |
| Simulator | `DELIVERED` | `simulated_receipt` (labelled) |

Email follows the same rule: SMTP 250 = `ACCEPTED`. The system never labels a message "inbox delivered".

**Call** (`voice/states.ts`): `QUEUED → DIALING → COMPLETED | NO_ANSWER | BUSY | FAILED`, with
`DIALING → QUEUED` for "I didn't call". Manual outcomes carry `user_attestation` evidence.

**Conversation engine** (`voice/engine.ts`): see [VOICE.md](VOICE.md).

## Jobs and idempotency

`enqueue(db, queue, payload, idempotencyKey)` writes a `job_records` row with a unique key. A
second enqueue with the same key returns the existing record. In queue mode it sends to pg-boss
with `singletonKey` and the queue's retry policy (`retryLimit`, `retryDelay`, `retryBackoff`).
Handlers are idempotent:

- `import.commit:<batchId>`: commit is a no-op once `COMMITTED`. After a crash, rows re-match
  against the DB and MERGE instead of duplicating.
- `sms.generate_drafts`: each draft has `idempotencyKey = sms:<provider>:<contact>:<purpose>:<campaign>:<day>`.
- Calls: `call:iphone_manual_call:<contact>:<campaign>:<day>`.
- Hand-off and confirmation are idempotent: a repeated tap returns the same URL or state.

## Schema

See `prisma/schema.prisma`, grouped by module. Tables you requested map 1:1:
`contacts, phone_numbers, marketing_permissions, message_drafts, sms_events, calls, call_events,
call_transcripts, voice_agent_configs, provider_configs, audit_logs`, plus `users, sessions,
companies, import_batches, import_rows, research_facts, lead_scores, suppressions,
system_settings, carrier_lines, airtime_entries, campaigns, campaign_members, email_accounts,
email_messages, linkedin_drafts, meetings, job_records, cost_entries`.

Tables for later phases (research, scoring, campaigns, email, LinkedIn, calendar) are designed
now so those modules don't force a CRM redesign.
