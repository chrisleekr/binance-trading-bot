# Operator deployment runbook

This document is the canonical first-run guide for an operator deploying binance-trading-bot to a private VM. The goal is **deploy on a clean VM in under 30 minutes** following the steps below.

The compose stack is intentionally edge-agnostic: it does not bundle a reverse proxy. Section [TLS at the edge](#tls-at-the-edge) covers three ways to put TLS in front of the stack; pick one.

---

## Prerequisites

- A Linux VM with `docker` (≥ 24) and `docker compose` (≥ 2.20).
- 2 vCPU, 4 GB RAM, 20 GB disk is enough for one master account / a handful of profiles.
- Outbound HTTPS to `api.binance.com` and `wss://stream.binance.com`.
- A Binance Spot API key + secret. The key MUST have the trading permission and IP-allowlisting MUST be enabled (see [Binance API key — IP allowlist](#8-ip-allowlist-your-binance-api-key)).
- 32 random bytes for `AUTH_SECRET` (`openssl rand -hex 32`).

---

## 9-step runbook

### 1. Clone the repository

```bash
git clone https://github.com/chrisleekr/binance-trading-bot.git
cd binance-trading-bot
```

### 2. Copy `.env.example`

```bash
cp .env.example .env
```

Edit `.env` at the repo root. For compose, set `DATABASE_URL` / `REDIS_URL` to the in-network DNS form (`postgres://postgres:postgres@postgres:5432/binance_trading_bot`, `redis://redis:6379`) or delete those lines to fall through to the compose file's built-in defaults; change `WEB_ORIGIN` to the URL the SPA will be reachable at.

### 3. Generate `AUTH_SECRET`

For development, write the value into `.env`:

```bash
# Overwrite the AUTH_SECRET= line in-place
sed -i.bak "s|^AUTH_SECRET=.*|AUTH_SECRET=$(openssl rand -hex 32)|" .env \
  && rm .env.bak
```

For production, three independent secrets are needed: postgres password, redis password, and the api's `AUTH_SECRET`. The compose stack handles them three different ways:

| Secret | Container | Wiring |
| --- | --- | --- |
| `postgres_password` | `postgres` | Native Docker-secret `_FILE` indirection (`POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password`) |
| `redis_password` | `redis` | `redis-server` reads the file inline via `$(cat /run/secrets/redis_password)` in its entrypoint |
| `session_secret` | `app` | The api does NOT support `_FILE` indirection; the operator must `sed`-inject the value into `.env` |

Generate the three secret files (the postgres and redis containers consume them as mounts; the api needs the `AUTH_SECRET` line patched into `.env`):

```bash
mkdir -p deploy/secrets
openssl rand -hex 32 > deploy/secrets/session_secret
openssl rand -hex 32 > deploy/secrets/postgres_password
openssl rand -hex 32 > deploy/secrets/redis_password
chmod 600 deploy/secrets/*

# AUTH_SECRET and REDIS_URL are read from env by the api — use sed (not
# `>>`) so re-running this block stays idempotent and does not duplicate
# the keys in .env.
REDIS_PW=$(cat deploy/secrets/redis_password)
sed -i.bak \
  -e "s|^AUTH_SECRET=.*|AUTH_SECRET=$(cat deploy/secrets/session_secret)|" \
  -e "s|^REDIS_URL=.*|REDIS_URL=redis://:${REDIS_PW}@redis:6379|" \
  .env \
  && rm .env.bak
chmod 600 .env
```

The prod `redis` service enforces `--requirepass`; without the auth-aware `REDIS_URL` the api/worker fail to connect.

### 4. Pull (or build) the images

A single image is published to Docker Hub by `release-please` (`.github/workflows/release-please.yml`) at `chrisleekr/binance-trading-bot` with an immutable version tag (`vX.Y.Z`); `latest` moves with each release on main. Pin a version in `.env` (`IMAGE_TAG`).

The Docker Hub repo is public, so unauthenticated pulls work. If you hit Docker Hub's anonymous rate limit, log in with any Docker Hub account first:

```bash
docker login
```

Then pull:

```bash
docker compose -f deploy/compose/docker-compose.yml \
               -f deploy/compose/docker-compose.prod.yml \
               --env-file .env pull
```

For air-gapped first-run or pre-release branches, build from source:

```bash
docker compose -f deploy/compose/docker-compose.yml build
```

### 5. Start the stack

```bash
docker compose -f deploy/compose/docker-compose.yml \
               -f deploy/compose/docker-compose.prod.yml \
               --env-file .env up -d
```

The `depends_on: { condition: service_healthy }` chain blocks the `app` service until Postgres + Redis are accepting connections, so a fresh boot completes cleanly without retry loops.

### 6. Database migrations (automatic on boot)

Migrations run automatically on boot: the container entrypoint (`apps/server/docker-entrypoint.sh`) runs the migration runner before starting the app, unless `SKIP_MIGRATIONS=1`. The runner is idempotent — every migration file is keyed by checksum in `_app_migrations`, so re-running is safe. A migration that fails exits the container non-zero and readiness never answers, so the orchestrator backs off rather than serving a stale schema. In the scale topology only the `api` service migrates; `worker`/`study` set `SKIP_MIGRATIONS=1`.

To run migrations manually (offline path), invoke the same binary:

```bash
docker compose exec app bun /app/dist/migrate.js
```

### 7. Open the URL — first-run onboarding

Browse to `WEB_ORIGIN`. The first-run UI prompts you to create the master account (Better Auth, argon2id, no email). Once an account exists, subsequent visits to `/onboarding` redirect to the login page; password recovery requires the operator-side `bun run reset-password` CLI documented below.

### 8. IP-allowlist your Binance API key

In the Binance API management UI, edit the key created for this bot and:

- Enable **Restrict access to trusted IPs only**.
- Add the public egress IP of your VM (use `curl -s ifconfig.me` from the VM to find it).
- Confirm the **Enable Spot & Margin Trading** permission is checked.

Without IP allow-listing, a leaked key dumps the entire account; this step is the threat model's primary mitigation since keys are stored plaintext in Postgres.

### 9. Verify healthchecks

The api exposes `/healthz`, `/readyz`, and `/metrics` on a separate admin listener bound to `127.0.0.1:$ADMIN_PORT` (default `9100`) — the public network cannot reach them. Under `ROLE=all` (and `ROLE=api`) the app serves them. Hit them from the VM itself:

```bash
docker compose ps                              # all services should show (healthy)
curl -fsS http://127.0.0.1:9100/healthz        # api liveness
curl -fsS http://127.0.0.1:9100/readyz         # api readiness (DB + Redis ping)
```

If `/readyz` returns 503, follow the [`troubleshooting`](#troubleshooting) section below.

---

## TLS at the edge

The default stack serves plain HTTP on the published `APP_HTTP_PORT` (prod default `80` → container `3000`); the `app` service serves both the SPA and `/api` same-origin, so there is no separate web edge. Production deployments MUST front the `app` service with TLS. Three reference configurations:

### Option A — Cloudflare Tunnel

Lowest-friction; no public ingress needed on the VM.

```bash
# On the VM, after `docker compose up -d`:
docker run -d --network=binance-trading-bot_internal \
  --name cloudflared --restart unless-stopped \
  cloudflare/cloudflared:latest tunnel \
  --no-autoupdate run --token <YOUR_TUNNEL_TOKEN>
```

In the Cloudflare dashboard, set the public hostname to forward to `http://app:3000` (the in-network DNS name of the `app` service).

### Option B — nginx / Traefik in front of compose

If the operator already runs an nginx or Traefik on the host:

**nginx fragment:**

```nginx
server {
  listen 443 ssl http2;
  server_name binance-trading-bot.example.com;
  ssl_certificate     /etc/letsencrypt/live/binance-trading-bot.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/binance-trading-bot.example.com/privkey.pem;

  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

  location / {
    # The `app` service, published on the host at APP_HTTP_PORT (prod default 80).
    proxy_pass         http://127.0.0.1:80;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Real-IP         $remote_addr;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto https;
    proxy_set_header   Upgrade           $http_upgrade;
    proxy_set_header   Connection        $http_connection;
    proxy_read_timeout 300s;
  }
}
```

**Traefik fragment** (in `traefik.yml` / dynamic config):

```yaml
http:
  routers:
    binance-trading-bot:
      rule: 'Host(`binance-trading-bot.example.com`)'
      entryPoints: [websecure]
      tls: { certResolver: letsencrypt }
      service: binance-trading-bot
  services:
    binance-trading-bot:
      loadBalancer:
        servers:
          # The `app` service, published on the host at APP_HTTP_PORT (prod default 80).
          - url: 'http://127.0.0.1:80'
```

Either approach: point the proxy's upstream at the `app` service — in network `http://app:3000`, or on the host `http://127.0.0.1:${APP_HTTP_PORT}`. The app serves both the SPA and `/api` same-origin on container port 3000, so a single upstream keeps the `Content-Security-Policy` aligned.

### Option C — Hosted reverse proxy (Vercel, Fly)

For VMs without public ingress, run the SPA on a hosted edge that tunnels back to the VM.

- **Vercel**: deploy the `apps/web` build artifact to Vercel; configure rewrites so `/api/*` proxies to the VM via a Cloudflare Tunnel or a Tailscale endpoint. Set `WEB_ORIGIN=https://<your-vercel>.vercel.app` in `.env`.
- **Fly.io**: `flyctl proxy 80:80 -a <fly-app>` against a Fly app with a `[[services]]` block forwarding to the VM via Tailscale or `wireguard`. Same `WEB_ORIGIN` discipline.

The compose stack is unchanged in all three cases.

---

## Restic off-host backup recipe

The compose stack ships a nightly `pg_dump` loop (`backup` service, `#66`/13.06) into `./backups` with 14-day local retention. Off-host shipping is the operator's choice; restic is the recommended tool.

### Install

```bash
# Ubuntu / Debian:
sudo apt install -y restic

# Or, latest binary:
curl -L https://github.com/restic/restic/releases/latest/download/restic_linux_amd64.bz2 \
  | bunzip2 -c | sudo tee /usr/local/bin/restic >/dev/null \
  && sudo chmod +x /usr/local/bin/restic
```

### Initial setup

Choose one storage backend; pick whatever the operator already has, then export the matching block (do not run all three back-to-back — `RESTIC_REPOSITORY` would be overwritten).

```bash
# Option 1 — AWS S3 / MinIO / any S3-compatible:
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export RESTIC_REPOSITORY=s3:s3.amazonaws.com/binance-trading-bot-backups

# Option 2 — Backblaze B2:
export B2_ACCOUNT_ID=...
export B2_ACCOUNT_KEY=...
export RESTIC_REPOSITORY=b2:binance-trading-bot-backups

# Option 3 — Storj (S3-compatible):
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export AWS_DEFAULT_REGION=eu1
export RESTIC_REPOSITORY=s3:gateway.storjshare.io/binance-trading-bot-backups
```

Then set the password file and initialise the repo:

```bash
export RESTIC_PASSWORD_FILE=/root/.restic-password
echo 'change-me-32-bytes-of-entropy' > /root/.restic-password
chmod 600 /root/.restic-password

restic init
```

### Daily cron

```bash
# /etc/cron.daily/restic-binance-trading-bot
#!/bin/sh
set -eu
. /etc/restic.env       # exports the AWS_/B2_/RESTIC_* vars above
cd /path/to/binance-trading-bot
restic backup ./backups --tag binance-trading-bot --tag $(hostname)
restic forget --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune
```

### Restore

```bash
restic snapshots
restic restore <snapshot-id> --target /tmp/restore

# List the restored files — backup filenames are timestamped, so pick
# the dump you want (e.g. binance-trading-bot-YYYYMMDDTHHMMSSZ.dump).
ls /tmp/restore/backups/

# `./backups` (relative to the repo root) is already bind-mounted into
# the postgres container at `/backups`, so drop the restored dump in
# that host dir and pg_restore from there — no extra `docker cp` needed.
# Run from the repo root, or anchor explicitly with $(git rev-parse --show-toplevel).
REPO_ROOT=$(git rev-parse --show-toplevel)
cp "/tmp/restore/backups/<dump>.dump" "$REPO_ROOT/backups/restore.dump"
docker compose exec -T postgres pg_restore \
  -U postgres -d binance_trading_bot /backups/restore.dump
```

`./backups` contains plaintext Binance API keys (per the threat model; see [security note](#sensitive-data)). The restic password must be kept off-host (a password manager, not the VM disk) so a host compromise does not leak the off-host backups.

---

## Sensitive data

`./backups/*.dump` and `postgres_data/` both contain plaintext Binance API keys (the design accepts this in exchange for IP-allowlisting at the Binance console). The operator MUST:

- `chmod 700 ./backups deploy/secrets` after the first run.
- Treat the off-host restic repo as a sensitive store (separate password file, not in this repo).
- Rotate Binance API keys if either the `./backups` directory or the Postgres volume is exposed.

---

## Troubleshooting

| Symptom | Cause | Resolution |
| --- | --- | --- |
| `/readyz` 503 with `redis ping failed` | Redis container not yet healthy | `docker compose logs redis` — typically a port collision on host |
| `/readyz` 503 with `db ping failed` | Postgres healthcheck still pending | `docker compose logs postgres` — extension setup can take ≥10 s on first run |
| Browser blocks API requests with CORS error | `WEB_ORIGIN` does not match the URL bar | Update `WEB_ORIGIN` in `.env`, `docker compose up -d` to roll the api |
| Binance returns `-2014` (API key format) | Whitespace or pasted prefix | Re-paste the key without surrounding quotes |
| Binance returns `-2015` (rejected by config) | IP allowlist missing the VM's egress IP, or key lacks Spot permission | See step 8 |
| Worker REST calls to Binance run slow under heavy cron load | Per-IP weight governor blocking callers to stay under Binance's 6000/min limit, by design | No tunable knob — the governor auto-throttles. If pathologically slow, check worker logs for a runaway fetch loop repeating one REST call. A `weight governor: Redis unavailable` warning instead points to Redis, not weight |
| `docker compose pull` rate-limited by Docker Hub | Anonymous pull quota exceeded | `docker login` with any Docker Hub account before retrying |
| `backup` service logs `dump failed (exit 1)` | Postgres password mismatch | Confirm `POSTGRES_PASSWORD` in `.env` matches the container's value |

---

## Operator commands

```bash
# Tail the app (api + live worker + study in one process)
docker compose logs -f app

# Run a one-shot backup
docker compose run --rm backup

# Reset the master password (offline)
docker compose run --rm app bun run reset-password

# Re-run DB migrations manually (they also run on boot via the entrypoint)
docker compose exec app bun /app/dist/migrate.js

# Stop everything (volumes preserved)
docker compose down

# Stop and wipe everything (DESTRUCTIVE)
docker compose down -v
```
