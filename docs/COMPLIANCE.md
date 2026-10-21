# Compliance model

> This encodes a conservative reading of South African law for product gating. It is **not legal
> advice**. Have counsel review it before running real campaigns.

## South Africa (`rulesFor("ZA")`)

| Rule | Source | Enforcement |
|---|---|---|
| Electronic direct marketing (SMS, email, automated calls) needs consent **or** an existing-customer relationship | POPIA s69(1), s69(3) | `checkEligibility()` blocks drafting and hand-off |
| A person who hasn't refused may be asked for consent **once** | POPIA s69(2) | `consent_request` purpose; logs `CONSENT_REQUESTED` when you confirm sending; blocks a second request |
| Every message identifies the sender and offers an opt-out | POPIA s69(4) | Sender profile required; approval rejects bodies without the business name or "STOP" |
| Honour opt-outs / pre-emptive blocks | CPA s11 | Suppression list (email / E.164 / domain, per channel or all); STOP replies and verbal opt-outs auto-suppress |
| Contact hours: weekdays 08:00–20:00, Saturdays 09:00–13:00, never Sundays or public holidays | CPA Reg 4 | Checked at hand-off and dial time (not at drafting); SA public holidays computed incl. Easter and the Sunday→Monday rule |
| Live human calls aren't s69 "electronic communication" | POPIA s69 | `VOICE_MANUAL` needs no consent in ZA, but opt-outs and contact hours still apply |

## Other or unknown countries

Strict opt-in: every marketing channel, including human calls, needs a recorded `GRANTED`
permission. Contacts with no country get strict rules plus a warning.

## Controls

- **Emergency stop** (Compliance page): any operator can halt; only a manager or admin can resume.
  Halting cancels every unsent draft and queued call. A red banner shows on every page.
- **Human approval**: managers approve each AI draft; the body is re-validated at approval.
- **Consent records** need an evidence string (form URL, signed doc ref, reply text) and capture time.
- **Audit log**: every login, import, draft, approval, hand-off, confirmation, outcome, consent
  change, provider change and emergency stop.
- **Provider authorisation**: automated providers need a written carrier/provider authorisation
  reference plus the env gate.

## Data handling

- No contact data is invented. Imports record `source = import:<batchId>`. AI drafts that contain
  numbers, emails or links are discarded.
- Phone numbers carry `source`, optional `sourceUrl` and `verifiedAt`; research facts require a source URL.
- The Telkom line record stores no SIM provisioning secrets.
- Voice sandbox audio isn't stored; transcripts are.
