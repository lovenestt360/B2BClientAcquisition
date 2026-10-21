# CLAUDE.md — Project rules for B2B Client Acquisition Platform

Claude Code is the **development tool** for this repo. It is never the production
AI inference backend. Production inference runs on self-hosted Ollama,
faster-whisper and Chatterbox TTS.

## Non-negotiable product rules

1. **Real outreach is off by default.** Every provider ships `enabled=false`.
   Automated sending/calling additionally requires `ALLOW_AUTOMATED_OUTREACH=true`
   in the environment **and** a recorded carrier/provider authorisation in
   `provider_configs`. Do not add code paths that bypass `assertCanAutomate()`.
2. **Never fabricate delivery evidence.** Message delivery state is one of
   `ATTEMPTED | ACCEPTED | DELIVERED | FAILED | UNKNOWN`. Only set `DELIVERED`
   from a provider receipt or other independent evidence. Manual iPhone SMS stays
   `UNKNOWN` after the user confirms sending. Never label an email
   "inbox-delivered"; SMTP acceptance is `ACCEPTED`, nothing more.
3. **Never invent contact details.** Emails/phones must come from an import,
   a user entry or a cited source URL with a verification timestamp. AI may draft
   messages; it may not produce contact data.
4. **Compliance before contact.** Every outreach action calls
   `checkEligibility()` (POPIA s69 / CPA rules for ZA, strict opt-in elsewhere),
   suppression checks and the global/campaign emergency stop.
5. **Human approval.** AI drafts require explicit human approval before any
   send action (manual or automated).
6. **No prohibited mechanisms.** No unauthorised LinkedIn automation (no auto-DMs,
   no scraping behind login), no SIM-box/grey routing, no connecting a consumer
   SIM to a PBX, no SIM cloning, no eSIM QR/activation-code handling or storage.
7. **No claimed audio access** to native iPhone cellular calls. Manual calls only
   record user-entered outcomes and notes.
8. **AI voice must disclose it is an AI** at the start of every conversation.
9. **Audit everything.** Every state-changing action writes `audit_logs` via
   `audit()`.
10. **Secrets live in environment variables**; provider credentials stored in DB
    are AES-256-GCM encrypted with `APP_ENCRYPTION_KEY`.

## Engineering conventions

- TypeScript strict. Next.js App Router + server actions. Business logic lives in
  `src/server/**` (framework-free, takes a Prisma client) so it is unit/integration
  testable. UI in `src/app/**` and `src/components/**` stays thin.
- Validate all external input with zod at the boundary.
- Background jobs go through `src/server/jobs` with an idempotency key; handlers
  must be safe to re-run.
- State transitions use the explicit transition tables in
  `src/server/messaging/states.ts` / `src/server/voice/states.ts`; never set
  status columns ad hoc.
- RBAC: check with `requireRole()` / `can()` in every server action.
- Tests: `npm test` (unit + integration, needs Postgres at `DATABASE_URL_TEST`),
  `npm run test:e2e` (Playwright). Add tests with every module.
- Migrations: `npx prisma migrate dev --name <change>`; never edit applied
  migrations.
