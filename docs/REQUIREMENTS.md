# Functional requirements and delivery status

Legend: ✅ implemented and tested · 🟡 schema and interfaces in place, implementation pending · ⛔ deliberately not built

## Cross-cutting

| Requirement | Status |
|---|---|
| Auth (email + password, DB sessions, lockout), RBAC, activity/audit logs | ✅ |
| Secrets in env; provider secrets AES-256-GCM encrypted at rest | ✅ (`server/crypto.ts`) |
| Background jobs with retries and idempotency keys | ✅ pg-boss + `job_records` |
| Distinct attempted / accepted / delivered / failed / unknown states; no fake "delivered" | ✅ enforced by transition table |
| Simulation mode with dummy leads and fake providers | ✅ `SIMULATION_MODE`, `simulated_sms`, `local_ai_sandbox`, seed |
| Real outreach disabled until configured and enabled | ✅ every real provider seeds `enabled=false`; automated providers gated |
| Unit, integration, end-to-end tests | ✅ Vitest + Playwright |
| Docker, migrations, seed, README, deployment docs | ✅ |

## Modules

| # | Module | Status | Notes |
|---|---|---|---|
| 1 | Companies & contacts, CSV/XLSX import, dedupe, validation | ✅ | Preview before commit; dedupe by email → phone → name+company; fill-blanks-only merges; per-field provenance |
| 2 | Research & enrichment with source URLs, timestamps, confidence | 🟡 | `research_facts` requires `sourceUrl`, `verifiedAt`, `confidence`; shown on the company page; collectors pending |
| 3 | AI lead qualification & campaign ICP scoring | 🟡 | `lead_scores` table; Ollama client ready |
| 4 | Campaign builder with per-channel instructions | 🟡 | `campaigns` has email/SMS/LinkedIn/call instructions, already used by SMS drafting and call guidance when a campaign is passed |
| 5 | Email SMTP/IMAP, inbox sync, reply classification, bounces, suppression | ✅ | Hostinger mailboxes, approval + click-to-send, crash-safe sends, IMAP sync, DSN bounces, auto-replies, unsubscribe → suppression, evidence-based delivery. See [EMAIL.md](EMAIL.md) |
| 6 | SMS gateway | ✅ iPhone manual · 🟡 Android gateway / business API (disabled interfaces) | Superseded by the Telkom/iPhone brief |
| 7 | Voice agent sandbox: STT, local LLM, TTS, interruption, transcripts | ✅ | Engine + browser sandbox + faster-whisper/Chatterbox services; **AI sales caller** with lead briefs, playbook, slot offers and meeting booking |
| 8 | Approved telephony adapter interface, mock calls only | ✅ | `asterisk_sip_ai` gated; ARI client and RTP framing scaffolding; sandbox = mock calls |
| 9 | LinkedIn research, drafts and approval; no auto-DMs | 🟡 | `linkedin_drafts` (user marks sent manually) · ⛔ no LinkedIn automation |
| 10 | Google Calendar booking & pipeline | 🟡 pipeline ✅ | Pipeline stages on contacts/companies are live; `meetings.googleEventId` reserved |
| 11 | Unified inbox, scheduling, pause/resume/emergency stop, audit, cost, analytics | ✅ unified inbox (email + SMS, triage), emergency stop, audit, airtime/cost, reports · 🟡 campaign scheduler | Inbox sync runs on a 5-minute schedule |
| 12 | Country-aware compliance, consent, suppression, approvals, credentials | ✅ | ZA rule pack (POPIA s69, CPA s11/Reg 4), strict default elsewhere |
| 13 | Email sequences (Klyron SA-CON / SA-PM): evidence-grounded generation, validation, gates, Maputo batches, caps, idempotency, reply/stop watch, reconciliation | ✅ dry run · ⛔ live until approved | See [OUTREACH.md](OUTREACH.md); Launch Command = Stop |

## Telkom prepaid iPhone channel

| Requirement | Implementation |
|---|---|
| Validate +27 numbers | `validateZaMobile()` (libphonenumber, mobile type) |
| POPIA eligibility | `checkEligibility()`: consent / existing customer / one consent request |
| AI SMS drafts | Ollama or mock; template fallback; rejects invented links, numbers and emails |
| Human approval of each message | Manager+ approves; body re-validated for sender ID and opt-out |
| Copy / open native Messages | `sms:+27…&body=` (iOS form) with Copy fallback |
| Require send confirmation | "I sent it / It failed / I didn't send it" |
| Delivery stays UNKNOWN | Transition table forbids DELIVERED without a receipt |
| Manual replies | Typed in; STOP-style replies → withdrawal + suppression + cancel pending drafts |
| Click-to-call | `tel:` link; AI talking points; manual outcome form |
| No call audio / recording claims | Adapter capabilities `callAudioAccess=false, callRecording=false`; shown in UI |
| Provider capabilities and limitations | Providers page lists both, per adapter |
| Airtime tracking | Top-ups, balance checks, estimated spend from user-entered rates |
| Future pay-as-you-go APIs | `business_sms_api`, `asterisk_sip_ai` adapters behind the gate |
| Carrier approval before automation | Authorisation reference required by the gate |
| Dummy leads | Never texted or dialled; hand-offs go to the configured test number or open without a recipient |
| ⛔ Not built | SIM cloning, eSIM QR/activation handling, SIM-box, consumer SIM → PBX |
