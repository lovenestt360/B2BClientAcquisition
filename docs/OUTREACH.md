# Email sequences (Klyron SA-CON / SA-PM)

Implements the approved *South Africa AI Outreach* specification inside this platform, on
Postgres, with no Airtable, Emailable or Gemini integration. **Live sending is off.** Every
batch runs as a dry run until all of the launch conditions below hold.

> **Scope, not a template.** The spec's examples are stored as labelled, non-binding reference
> material (`config/klyron-sa-reference-examples.md`). Emails are written per lead from that
> lead's own sourced research. There is no fixed step-to-topic mapping.

## Where things live

| What | Where |
|---|---|
| Campaigns, sender, schedule, caps, capabilities, exposure library, banned claims | `config/klyron-sa-outreach.json`, loaded on **/outreach**. Editable data, not code |
| Wait days between steps | `outreach_steps`. `null` in config; a step is **held** until a manager approves its wait on /outreach |
| Booking URL | Setting on /outreach. None was found in the Klyron code, so it stays blank (reply-based CTA) until you add one |
| Per-recipient sequence state | `campaign_members`: state, final approval, last confirmed step and time, next due, stop/hold reason |
| One row per prospect + campaign + step | `outreach_sends` (unique `idempotencyKey` `<contact>:<campaign>:S0n`; dry runs prefixed `dry:`): content, model output, validation, approval, Message-ID, SMTP response, confirmation time, attempts |
| Research and need evidence | `research_facts` (company or contact; `kind` = fact, project, sector, need_evidence; `isInference`; source URL, confidence and verification time required) |
| Permission basis and evidence | `marketing_permissions` (EMAIL, GRANTED, CONSENT or EXISTING_CUSTOMER, with evidence) |
| Suppression | `suppressions` (shared with every other channel; never overwritten) |
| Audit trail | `audit_logs` (`outreach.*` actions) |

## Pipeline

```
enrol (PENDING_APPROVAL) → final SA approval (ACTIVE)
  → each tick: stop recheck → position from confirmed sends → due? → lead gates
  → generate (model or evidence composer) → validate against evidence → AWAITING_APPROVAL | HELD | RESEARCH_REQUIRED
  → human approves (edits re-validated) → next batch: atomic cap reservation → send → PROVIDER_ACCEPTED (SMTP 250)
```

**Lead gates, checked before drafting and again right before each send.** Any failure means
HOLD with a reason code: campaign configured, active and not emergency-stopped (CAMPAIGN_*,
EMERGENCY_STOP); country ZA (WRONG_COUNTRY); company and ICP role (ICP_*); email present and
verified as `Valid` (EMAIL_*); no duplicate across campaigns or person (DUPLICATE); final
approval (NOT_APPROVED); a verified, sourced fact and need evidence (RESEARCH_INSUFFICIENT,
NEED_EVIDENCE_MISSING → RESEARCH_REQUIRED); suppression or opt-out (SUPPRESSED, OPT_OUT);
documented consent or existing customer (PERMISSION_MISSING; a consent *request* is never a
sales sequence); CPA contact hours.

**Batch and send checks.** Launch Command and environment (dry run otherwise); Maputo slot
Mon–Fri at 09:00–15:00, open for 50 minutes, skipping SA public holidays; the step is due
(previous **provider-confirmed** send + approved wait, rolled forward to the next batch and
never early); no unconfirmed earlier attempt; one step per recipient per batch; 20 per hour and
140 per day across both campaigns, reserved under a Postgres advisory lock. Unknown outcomes
count against the caps.

**Validator** (`server/outreach/validate.ts`). It checks the content against the lead's
evidence and doesn't trust the model's self-report:
exactly one specific 15-minute meeting CTA; no names, projects or numbers missing from that lead's
research; cited evidence IDs must belong to the lead; no invented events, inside knowledge,
prior-contact pretence, fake urgency or guarantees; honest subject (no Re:/Fwd:, ≤ 70 chars);
at most one https link on an approved domain, no shorteners (an approved booking link is allowed
in **any** step, S01 included); no contact details; 40–130 words (55–90 preferred);
materially different exposure, subject and wording from earlier steps.

**Reply & stop watch** (ingest hook plus a recheck before every send):

| Event | Effect |
|---|---|
| Human reply (interested / not interested / question) | STOPPED `REPLY`; pending steps withdrawn; the reply is in the Inbox for you |
| Unsubscribe | opt-out recorded, suppressed, STOPPED `OPT_OUT` |
| Hard bounce | suppression first, then STOPPED `HARD_BOUNCE` |
| Confirmed meeting (scheduled / completed) | STOPPED `BOOKED` |
| Tentative meeting | HOLD `BOOKING_TENTATIVE` |
| Soft bounce | HOLD `SOFT_BOUNCE` (no suppression) |
| Out-of-office | logged only |
| Unclassifiable reply | HOLD `REPLY_UNCERTAIN` |

Nothing is ever auto-replied.

**Crash safety.** The attempt is recorded (SENDING, Message-ID) before the SMTP call.
Connection-level failures release it for retry. An ambiguous failure becomes UNKNOWN, is
never resent, and blocks the next step until you record what the Sent folder shows.

## Going live (not done; needs your explicit approval)

All of these are required. Until then every batch is a dry run that opens no connection.

1. Legal review of the POPIA s69 basis. Leads need recorded **consent** or **existing-customer**
   evidence; a verified business address is not permission.
2. Mailbox: add `contact@klyronconsulting.com` on **Mailboxes**, pass **Test connection**,
   enable it, select it on /outreach. Check SPF, DKIM and DMARC alignment for Hostinger first.
3. Approve the wait days for S02–S05 for both campaigns. Add a booking URL if you have one.
4. Activate the SA-CON / SA-PM campaigns (they load as Draft).
5. Providers: enable **Scheduled email sequences (Hostinger)** and record the authorisation
   reference (your legal sign-off).
6. Environment: `SIMULATION_MODE=false`, `ALLOW_AUTOMATED_OUTREACH=true`, `OUTREACH_LIVE_SEND=true`,
   and `OUTREACH_SCHEDULER=true` on the worker.
7. Run the worker (`npm run worker`) on an always-on machine. Vercel Hobby can't run hourly
   batches, and the self-hosted model (Ollama) can't run on Vercel.
8. As admin, set Launch Command = Start (type the confirmation). Setting Stop takes effect at the
   very next send.

Every email still needs a human approval in the /outreach review queue.

## Rehearsal

`npm run outreach:rehearsal` runs the full pipeline on synthetic leads in an isolated
`acquisition_rehearsal` database. It refuses any other database name and writes
[OUTREACH_DRY_RUN.md](OUTREACH_DRY_RUN.md).
