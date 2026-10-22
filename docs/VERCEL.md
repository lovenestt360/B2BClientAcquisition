# Deploying on Vercel

Vercel runs `npm run vercel-build`, which:

1. generates the Prisma client,
2. applies migrations (`prisma migrate deploy`, over the unpooled connection when Neon provides one),
3. seeds safely: creates **only your admin account** (and, in simulation mode, the dummy leads and
   simulated mailbox). It **fails the build** if `SEED_ADMIN_PASSWORD` is missing, is the default,
   or is shorter than 12 characters,
4. builds Next.js.

Re-deploying is safe: migrations and the seed are idempotent and never overwrite your data.

## 1. Database

Vercel → Storage → **Create Database → Neon (Postgres)** and connect it to the project. That adds
`DATABASE_URL` (pooled) and `DATABASE_URL_UNPOOLED` (used for migrations). Neon has a free tier.

## 2. Environment variables (Project → Settings → Environment Variables)

| Name | Value |
|---|---|
| `APP_ENCRYPTION_KEY` | output of `openssl rand -base64 32` (keep a copy: mailbox passwords can't be decrypted without it) |
| `SEED_ADMIN_EMAIL` | your login email |
| `SEED_ADMIN_PASSWORD` | a long, unique password (12+ characters) |
| `COOKIE_SECURE` | `true` |
| `SIMULATION_MODE` | `true` while testing (dummy leads, simulated mailbox); `false` for real use |
| `ALLOW_AUTOMATED_OUTREACH` | `false` |
| `APP_TIMEZONE` | `Africa/Johannesburg` |
| `CRON_SECRET` | a random string (Vercel sends it to the cron endpoint) |

Leave `LLM_PROVIDER`, `STT_PROVIDER` and `TTS_PROVIDER` unset (mock). Ollama, faster-whisper and
Chatterbox can't run on Vercel. Drafts use the built-in templates and the voice sandbox uses the
browser voice.

After adding variables, **Redeploy** (Deployments → ⋯ → Redeploy). Variables only apply to new builds.

## 3. Sign in

Open `https://<your-project>.vercel.app/login` with `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`.
On the iPhone: Safari → Share → **Add to Home Screen**. With HTTPS the offline page works too.

## Limits on Vercel

- **Plan:** Vercel Hobby is for non-commercial use. Using this for your business generally needs
  Pro (a paid subscription). The laptop or a small VPS avoids that.
- **No background worker:** jobs run inline in the request (`JOBS_MODE` defaults to inline).
- **Inbox sync:** `vercel.json` schedules `/api/cron/email-sync` once a day (the Hobby maximum).
  Use **Email → Check inbox now** for immediate syncs.
- **Login throttling** is per server instance. Vercel's firewall rate limiting adds protection.
- **No local AI:** see above. For real Ollama/voice, use the Docker deployment (docs/DEPLOYMENT.md).
