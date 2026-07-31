# Security Policy

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report it through GitHub's private channel: [**Report a vulnerability**](https://github.com/chrisleekr/binance-trading-bot/security/advisories/new). That creates a private advisory only you and the maintainer can see.

Please include what you were running (image tag or commit), what you did, what happened, and what you expected. A proof of concept helps but is not required.

This is a single-maintainer hobby project, not a funded product. Expect a first response within about a week. There is no bug bounty.

## Supported versions

Only the latest release on `main` is supported. Fixes ship forward; there are no backports to older tags.

## What this software handles

This bot holds **Binance API keys** and places real orders. Read this before deploying it.

- **Secrets are stored unencrypted.** Binance API keys and notifier credentials live in plaintext in Postgres. There is no encryption at rest. Anyone with database access, a database backup, or filesystem access to the host has your keys. This is a deliberate trade-off for a single-operator self-hosted tool, documented in `docs/architecture/auth.md`.
- **Compensating control: allowlist your IP on Binance.** Restrict the API key to your server's IP, and do not enable withdrawal permission. This is the control that actually limits the blast radius of a key leak.
- **Authentication is a single operator account.** No email verification, no second factor.
- **Do not expose this to the internet without TLS and your own access control.** `deploy/README.md` covers three TLS options.

## Scope

In scope: authentication and session handling, account and profile isolation (one operator's data reaching another scope), secret leakage into API responses or logs, remote code execution, dependency vulnerabilities with a practical exploit path here.

Out of scope: the unencrypted-secrets design above (known and documented); anything requiring existing host or database access; trading losses, strategy behaviour, or configuration mistakes.
