# Deployment

**Laptop (simplest):** `npm run laptop`. See the README. The phone connects over Wi-Fi while the
laptop is awake. The rest of this page covers an always-on server.

Target: one Linux host (VPS or office machine) with Docker. With voice, a machine with an NVIDIA
GPU is recommended for Chatterbox.

## 1. Configure

```bash
git clone <repo> && cd b2bclientacquisition
cat > .env <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 24)
APP_ENCRYPTION_KEY=$(openssl rand -base64 32)
COOKIE_SECURE=true
SIMULATION_MODE=true            # flip to false when you are ready for real contacts
ALLOW_AUTOMATED_OUTREACH=false  # keep false: there is no authorised automated channel
SEED_ADMIN_EMAIL=you@yourdomain.co.za
SEED_ADMIN_PASSWORD=<long passphrase>
EOF
chmod 600 .env
```

Back up `APP_ENCRYPTION_KEY`. Encrypted provider credentials can't be recovered without it.

## 2. Start

```bash
docker compose up -d --build                  # db + app + worker
docker compose exec app npx tsx prisma/seed.ts  # first run: admin user, providers, (sim) dummy leads
# optional
docker compose --profile ai up -d && docker compose exec ollama ollama pull llama3.1:8b
docker compose --profile voice up -d --build
```

The app container runs `prisma migrate deploy` on every start. The worker runs pg-boss queues with
retries (`JOBS_MODE=queue`).

## 3. TLS and access

The app binds to `127.0.0.1:3000`. Put a reverse proxy with TLS in front, for example Caddy:

```
crm.yourdomain.co.za {
  reverse_proxy 127.0.0.1:3000
  @login path /login
  rate_limit @login 10r/m   # with the caddy-ratelimit plugin, or use fail2ban
}
```

The iPhone uses the site in Safari. Add it to the Home Screen for an app-like experience;
`sms:` and `tel:` links open Messages and Phone directly. With
HTTPS the offline page and the phone microphone (voice sandbox) also work. To reach a compose
deployment directly from a phone on the LAN without a proxy, set `APP_BIND=0.0.0.0` and
`COOKIE_SECURE=false`.

## 4. Going live with real contacts (manual iPhone channel)

1. Set `SIMULATION_MODE=false` and restart. Simulated providers are then not seeded enabled; existing rows stay as they are.
2. Compliance → set the business name and opt-out text.
3. Providers → enable *iPhone Messages* and *iPhone Phone app*; enter your Telkom prepaid rates.
4. Import contacts; record consent evidence per contact (or mark existing customers).
5. Keep `ALLOW_AUTOMATED_OUTREACH=false`.

## 5. Backups

```bash
docker compose exec -T db pg_dump -U app acquisition | gzip > backup-$(date +%F).sql.gz
```

Schedule it daily (cron) and copy off-host. Test restores.

## 6. Upgrades

```bash
git pull && docker compose up -d --build   # migrations apply automatically
```

## Hostinger email and Google Calendar (later phases)

These use your existing accounts directly: Hostinger SMTP `smtp.hostinger.com:465`, IMAP
`imap.hostinger.com:993`, credentials stored encrypted, and a Google Calendar OAuth client in
your own Google Cloud project. No third-party relay is involved.
