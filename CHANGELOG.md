# Changelog

## 1.0.0 (2026-08-01)

Complete rewrite. Shares a name and a purpose with the v0.x line and nothing else.

### Features

- Strategies are plugins behind a shared contract — trailing-trade, momentum, and rebalance ship, one per profile
- Backtest a configured strategy against historical candles; every run is kept for comparison
- Multi-account, multi-profile: one operator owns N Binance accounts, each running N profiles against its shared wallet
- Crash-only worker with idempotent jobs, per-account Binance rate isolation, and version-aware per-symbol state commits
- `decimal.js` money end to end, lint-enforced at the strategy boundary
- Mobile-first PWA with a per-symbol workspace for market data, signals, orders, and manual overrides
- Slack, Telegram, and webhook notifications behind a common provider contract
- Technical indicator ratings computed in-process, no external scanner

### Notes

- No in-place upgrade from v0.x. The datastore moved to Postgres + TimescaleDB and no migration is provided — treat this as a fresh install. The v0 line is frozen at v0.0.101 (`v0-final`).
- Binance API keys and notifier secrets are stored unencrypted in Postgres, a deliberate single-operator tradeoff. IP-allowlist your Binance key. See the auth threat model in the docs.
