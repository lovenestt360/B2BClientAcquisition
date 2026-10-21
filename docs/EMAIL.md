# Email (your Hostinger mailboxes)

The platform sends from your own mailbox over **SMTP** and reads replies over **IMAP**. There's no
third-party sending service and no new subscription.

## Setup

1. **Email → Mailboxes → Add a Hostinger mailbox.** Defaults are `smtp.hostinger.com:465` and
   `imap.hostinger.com:993` (SSL/TLS). The password is stored encrypted with `APP_ENCRYPTION_KEY`.
2. **Test connection.** This logs in to SMTP and IMAP and sends nothing.
3. **Enable.** Enabling is refused until a test has passed.
4. Keep the **daily limit** low at first (20–30/day) and raise it slowly. Hostinger enforces its own
   sending limits too.

### Deliverability checklist (in your Hostinger DNS)

- **SPF**: `v=spf1 include:_spf.mail.hostinger.com ~all` (Hostinger adds it for domains it hosts)
- **DKIM**: enable it in hPanel → Emails → your domain
- **DMARC**: start with `v=DMARC1; p=none; rua=mailto:you@yourdomain.co.za`
- Send plain, personal emails to people who have a lawful basis to receive them. The platform
  already adds your business name, an unsubscribe line and a `List-Unsubscribe` header.

## Sending rules

- AI drafts → a manager **approves** each one → a person clicks **Send**. Nothing sends on its own.
- Compliance is checked when drafting **and** again at send time: consent or existing-customer
  basis (POPIA s69), suppression, CPA contact hours, emergency stop.
- Real mailboxes never email dummy leads; the simulated mailbox only emails dummy leads.
- **Crash-safe:** the attempt is recorded before talking to SMTP. If the outcome is unclear (the
  connection dropped after the message data was sent), the email is marked `UNKNOWN` and is
  **never resent automatically**. Check your Sent folder.

## Delivery evidence

| What happened | State | Evidence shown |
|---|---|---|
| SMTP server answered 250 | `ACCEPTED` | "mail server accepted it" (**not** "delivered") |
| SMTP refused the recipient | `FAILED` | "mail server refused it" |
| Hard bounce notice (5.x.x DSN) | `FAILED` + suppressed | "bounce notice received" |
| Soft bounce (4.x.x) | unchanged; code recorded | — |
| Recipient replied | `DELIVERED` | "recipient replied" |
| Recipient's auto-reply (out of office) | `DELIVERED` | "recipient's auto-reply" |

There's no tracking pixel or link tracking. Open tracking is unreliable, and it's personal-data
collection you'd have to justify.

## Inbox sync

The worker checks every enabled mailbox's **INBOX** every 5 minutes (there's also a "Check inbox
now" button). It's read-only, so it never marks messages as read or moves them. It:

1. fetches new messages by UID (UIDVALIDITY changes trigger a safe re-scan, deduplicated by Message-ID),
2. ignores copies of your own sent mail,
3. detects **bounces** (DSN) and **auto-replies** (RFC 3834 headers / subjects),
4. matches replies to your sent email via `In-Reply-To` / `References`, then by sender address,
5. classifies: rules first (unsubscribe, bounce, auto-reply), then Ollama (or the offline keyword
   classifier) picks from interested / not interested / question / other,
6. **unsubscribe** → consent withdrawn, address suppressed, pending email drafts cancelled;
   **interested / question** → contact moves to *engaged*.

Everything inbound shows up in **Inbox**, together with SMS replies, with Done / Reopen triage.
You reply from your normal mail app (Hostinger webmail or iPhone Mail); those replies thread
normally and the next sync picks up the answer.
