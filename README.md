# B2B Client Acquisition Platform

A self-hosted, compliance-first B2B client acquisition platform: CRM, lead import and dedupe,
iPhone-assisted SMS and calling over a Telkom prepaid line, and a local AI voice sandbox.

Stack: Next.js 15, TypeScript, Tailwind 4, PostgreSQL 16, Prisma 6, pg-boss 10, Ollama,
faster-whisper, Chatterbox TTS, Docker Compose. No SaaS subscriptions.

> **Safe by default.** Simulation mode is on, every real channel starts disabled, and automated
> SMS/calling is blocked unless `ALLOW_AUTOMATED_OUTREACH=true`, the provider is enabled, *and*
> a carrier authorisation is recorded. No authorised automated channel exists today.

## What works now

| Area | |
|---|---|
| Auth & RBAC | Email/password, DB sessions, lockout; Admin / Manager / Operator / Viewer; audit log |
| CRM | Companies, contacts, phones with provenance, pipeline stages, dashboard |
| Import | CSV/XLSX → column detection → validation → dedupe preview → idempotent commit (job) |
| Compliance | POPIA s69 / CPA Reg 4 eligibility, consent records, suppression, STOP handling, emergency stop, sender identity |
| SMS (iPhone) | AI draft → manager approval → Copy / Open in Messages (`sms:`) → you confirm; delivery stays **unknown**; manual reply entry; conversation view |
| Calls (iPhone) | Call queue, `tel:` dial button, lead profile + AI talking points, manual outcomes, cost estimates |
| AI voice sandbox | Disclosure, turn-taking, barge-in, silence handling, opt-out, human takeover, emergency hang-up, transcripts |
| Providers | Capabilities and limitations per channel, Telkom prepaid line, airtime ledger; future SMS API / Android gateway / Asterisk SIP behind the gate |
| Reports | SMS sent and replies, call outcomes, connect rate, meetings, opt-outs, airtime |

Roadmap modules (email, enrichment, scoring, campaigns UI, LinkedIn drafts, Google Calendar):
schema is in place; see [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md).

## Quick start (development)

```bash
cp .env.example .env            # then set APP_ENCRYPTION_KEY=$(openssl rand -base64 32)
docker compose up -d db         # or use a local Postgres 16
npm ci
npx prisma migrate deploy
npm run db:seed                 # admin@example.com / ChangeMe!2026 + dummy leads
npm run dev                     # http://localhost:3000
```

Seeded users (same password): `admin@`, `manager@`, `operator@`, `viewer@example.com`.

`JOBS_MODE` defaults to `inline` (jobs run in the request) for development. Compose runs a
separate worker with `JOBS_MODE=queue`.

## Production

```bash
docker compose up -d --build                 # db + app + worker
docker compose --profile ai up -d            # + Ollama
docker compose --profile voice up -d --build # + faster-whisper + Chatterbox
```

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Tests

```bash
npm test           # unit + integration (needs Postgres; DATABASE_URL_TEST)
npm run test:e2e   # Playwright, desktop + iPhone viewport (DATABASE_URL_E2E)
npm run typecheck
```

## Docs

- [Architecture, providers, state machines, jobs](docs/ARCHITECTURE.md)
- [Requirements and status](docs/REQUIREMENTS.md)
- [Compliance model (POPIA / CPA)](docs/COMPLIANCE.md)
- [Voice: engine, sandbox, future SIP](docs/VOICE.md)
- [Testing, including the manual iPhone checklist](docs/TESTING.md)
- [Deployment](docs/DEPLOYMENT.md)
- [CLAUDE.md](CLAUDE.md): project rules for development with Claude Code

## Things this platform will not do

Unauthorised LinkedIn automation; SIM-box or grey routing; connecting a consumer SIM to a PBX; SIM
cloning or eSIM QR/activation-code handling; claiming access to iPhone call audio; marking an SMS
or email "delivered" without independent evidence; contacting anyone without a lawful basis.
