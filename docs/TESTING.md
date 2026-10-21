# Testing

## Automated

```bash
# Postgres needed for integration and e2e (local or `docker compose up -d db`)
createdb acquisition_test && createdb acquisition_e2e
npm test              # unit + integration (Vitest)
npm run test:e2e      # Playwright: builds the app, resets acquisition_e2e, seeds, runs desktop + iPhone viewport
```

| Suite | Covers |
|---|---|
| `tests/unit` | normalisation, phone validation, import parsing/mapping/validation/dedupe, RBAC, crypto, POPIA/CPA rules and holidays, SMS composition and segmenting, invented-detail guardrail, state machines, Telkom adapter URLs, automation gate, conversation engine (disclosure, barge-in, backchannel, silence, opt-out, identity question, human handover, emergency hang-up, LLM failure), RTP framing, ARI gating |
| `tests/integration` | sessions and lockout; import preview → commit, idempotent re-runs and crash recovery; eligibility matrix (consent, existing customer, one consent request, withdrawal, suppression, emergency stop, contact hours, unknown country); full iPhone SMS lifecycle with DB state and events; failure / not-sent / reject paths; job-queue idempotency; opt-out replies; disabled-by-default and gated providers; simulated provider; dummy-lead redirection; manual call lifecycle with cost estimate; verbal opt-out; voice sandbox persistence and agent validation |
| `tests/e2e` | login and RBAC, dashboard, CSV import UI, enabling providers, SMS draft → approve → Messages hand-off → confirm (delivery unknown) → STOP reply, call queue → `tel:` → outcome, voice sandbox, emergency stop, reports, iPhone-width layout |

Integration tests refuse to run unless `DATABASE_URL_TEST` contains "test". E2E setup refuses
unless the database name contains "e2e". E2E pins `SIMULATION_CLOCK` (Wednesday 10:00 SAST) so
contact-hour rules are deterministic.

## Manual iPhone checklist (Telkom prepaid)

Use dummy leads first. Set **Providers → Test number** to your *own* second phone, so hand-offs
for dummy leads go there and never to a fictional number.

| # | Step | Expected |
|---|---|---|
| 1 | Open the site in iPhone Safari and sign in | Dashboard fits the screen; menu button shows navigation |
| 2 | SMS → select *Aisha Patel (dummy)* → Generate | 1 draft created; ineligible leads skipped with the reason |
| 3 | Approve (edit the text if you like) | Draft moves to "Send from your iPhone" |
| 4 | Tap **Copy message**, then paste into Notes | Exact text pasted |
| 5 | Tap **Open in Messages (test)** | Messages opens addressed to your test number with the body pre-filled |
| 6 | Press Send in Messages, return to Safari, tap **I sent it** | History shows "delivery unknown"; the conversation shows "evidence: user attestation" |
| 7 | Reply "STOP" from the test phone, then paste the reply on the conversation page | "Opt-out recorded"; the number is suppressed |
| 8 | Calls → add *Johan Botha (dummy)* → **Call Johan** | Phone app dials your test number |
| 9 | After the call, choose an outcome and duration | The call moves to Recent; Reports update |
| 10 | Compliance → **Stop all outreach now** | Red banner; Open in Messages refuses until resumed |
| 11 | Try the same on a Sunday or after 20:00 (real clock) | Hand-off blocked with the CPA Reg 4 reason |

## Voice sandbox (local)

1. Mock mode: AI voice → Start simulated call. The agent says it's an AI. Type replies. Typing
   while it speaks interrupts it. Wait without typing to hear silence reprompts.
2. Full mode (`--profile ai --profile voice`, providers set to `ollama`/`http`): use the
   microphone with headphones and talk over the agent to check barge-in.
3. Check the transcript under Calls → Recent (sandbox) → transcript with `interrupted` markers.
