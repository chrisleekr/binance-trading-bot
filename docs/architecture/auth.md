# Auth

Canonical references for the auth surface — the in-repo files are the source of truth, this page summarises the constraints those files encode.

- `apps/api/src/auth.ts` — Better Auth factory: email + password only, argon2id, no SMTP, no 2FA, login throttle 60s / 5, session cookie 24h with sliding refresh < 1h idle.
- `apps/api/src/routes/auth.ts` — onboarding gate (single master account), sign-up / session / change-password handlers.
- `apps/api/src/routes/account-settings.ts` — `GET`/`PATCH /account/settings` for the master user's account-global display preferences. Today this carries `timezone` (a validated IANA zone, default `UTC`) the web UI applies to every rendered timestamp; the value persists on `users.timezone`.
- `packages/db/migrations/0007_better_auth.sql` — Better Auth tables.
- `packages/db/src/schema/better-auth.ts` — drizzle schema for the same.
- `apps/api/src/middleware/cors.ts` / `apps/api/src/routes/ws.ts` — the `WEB_ORIGIN` allowlist (a comma-separated list of exact `scheme://host:port` origins) gates CORS, Better Auth `trustedOrigins` (CSRF), and the WebSocket upgrade. Every origin is matched exactly; a `*` wildcard is rejected at env-parse time because credentialed CORS forbids it. Add a LAN origin to reach the dev server from another device.

## Threat model

The system ships **without** encryption-at-rest. Binance API keys, notifier secrets, and AI-assist provider credentials (`ai_provider_config` — the Anthropic Console key / OAuth token and any OpenAI-compatible endpoint key, a spend-capable credential) sit plaintext in Postgres; the mitigation is operator-side and twofold: (1) create the Binance API key without the **Enable Withdrawals** permission — the bot only reads market data and places spot orders, so a leaked key cannot move funds off the exchange — and (2) IP-allowlist the key at the Binance console so a stolen DB dump cannot place orders without also matching the operator's egress IP. The create wizard and the API-key replace form surface both via the shared `ApiKeyGuidance` component. Step-up / TOTP was deliberately dropped because the system runs single-account on a self-hosted VM — adding a second factor without an email channel for recovery would lock the operator out on phone loss with no fallback.

Warn/error `action_logs` rows (`msg` + `ctx`) are now client-readable via `GET /profiles/:id/action-logs` (the activity-feed errors filter), so worker writers MUST keep secrets — API keys, signed URLs, raw credentials — out of `action_logs` `msg`/`ctx`.

**Client-IP trust boundary.** The login rate-limiter (`apps/api/src/middleware/login-rate-limit.ts`) and the audit trail (`apps/api/src/middleware/audit.ts`) derive the client IP from the **rightmost** `X-Forwarded-For` hop via the shared `clientIp` helper, falling back to `X-Real-IP` then the literal `'unknown'`. This trusts exactly **one** reverse proxy that appends the real client address to the right of the chain (the bundled nginx `$proxy_add_x_forwarded_for` config does this). The API therefore MUST run behind exactly one such proxy: expose it directly and the leftmost-to-rightmost chain is fully client-controlled, re-opening per-IP throttle bypass and audit-IP spoofing; front it with two or more proxies and the rightmost hop is an internal proxy, collapsing all clients into one bucket. A request with no forwarded headers records `'unknown'` (not SQL `NULL`) in `audit_logs.ip`.

## Live demo (public, no-login, testnet deployment)

`LIVE_DEMO` (env, read by both the api and the worker; parsed strictly — only `1`/`true` enable it, default off) turns a **separate** deployment into a public sandbox. It is never the operator's real instance, which always requires login.

- **No login.** `sessionResolver` (`apps/api/src/middleware/auth.ts`) injects the boot-resolved sole operator id (`repo.users.findSingleId`, resolved once in `di.ts` boot) for every request with no Better Auth session. A real session still wins. Zero-user cold start injects nothing, so `/onboarding` still works. The login screen never appears (it is only shown reactively by the 401 interceptor).
- **Boot refuses a live key.** `assertLiveDemoInvariant` (`apps/api/src/di.ts`; mirrored in the worker boot) throws when the flag is on and any account is `binance_mode='live'`. The box can only ever hold testnet keys, so "no sensitive info exposed" holds by construction.
- **Locked routes.** `requireNotDemo` (`apps/api/src/middleware/require-not-demo.ts`, reads `di.env.LIVE_DEMO` at request time) returns 403 on the credential / destructive / notifier-target surfaces: api-keys, backup + backup-config + restore, ai-provider (+ test), ops-notify, account create, and the auth change-password / sign-out / sign-in routes. `apps/api/__tests__/routes/live-demo-guard.test.ts` asserts every one, so a sensitive route added later cannot silently become public.
- **Notifier suppression (worker).** Under the flag both notifier fan-outs (`createNotifyEvent`, `createAccountNotifyEvent`) are total no-ops — no dispatch, DB gate unread — so a seed snapshot's real webhooks can never leak.
- **Web.** The onboarding-status response carries `demoMode`; the SPA renders a persistent "Live demo" banner and hides the entry points to the now-403 routes (Settings, backup, account settings).

The ops half (testnet golden-snapshot seeding, the separate deployment, the nightly reset that re-restores the snapshot directly rather than via the locked `/restore` route, and public-endpoint rate limiting) is operator-side. Compose override: `deploy/compose/docker-compose.demo.yml`.
