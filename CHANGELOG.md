# Changelog

## [1.3.0](https://github.com/chrisleekr/binance-trading-bot/compare/v1.2.0...v1.3.0) (2026-08-23)


### Features

* **discovery:** surface asset-policy aborts to the operator ([#755](https://github.com/chrisleekr/binance-trading-bot/issues/755)) ([8e20233](https://github.com/chrisleekr/binance-trading-bot/commit/8e202332d051d066776518d8f5c86bd88e950782))
* **observability:** alert on the new counters and unit-test the rules ([#757](https://github.com/chrisleekr/binance-trading-bot/issues/757)) ([c7e96a0](https://github.com/chrisleekr/binance-trading-bot/commit/c7e96a06e212aaeb92c692c21f44ab454c423c68))


### Bug Fixes

* **archive:** recover the real exit reason on backfilled cycles ([#756](https://github.com/chrisleekr/binance-trading-bot/issues/756)) ([74790d2](https://github.com/chrisleekr/binance-trading-bot/commit/74790d2080c918fa3765cb2cf68e08249c28992e))
* clear position-scoped state fields on every position close ([#761](https://github.com/chrisleekr/binance-trading-bot/issues/761)) ([7c5ffbc](https://github.com/chrisleekr/binance-trading-bot/commit/7c5ffbc24a97f08f63360a424ff18f82a7a5bc94))
* **worker:** flatten sub-notional dust instead of stranding the position ([#754](https://github.com/chrisleekr/binance-trading-bot/issues/754)) ([6e51c2a](https://github.com/chrisleekr/binance-trading-bot/commit/6e51c2ae93965ccc6fbd8b215da16cd7d2f910b0))

## [1.2.0](https://github.com/chrisleekr/binance-trading-bot/compare/v1.1.0...v1.2.0) (2026-08-18)


### Features

* **discovery:** exclude stablecoins and fiat using Binance's own classification ([#750](https://github.com/chrisleekr/binance-trading-bot/issues/750)) ([ee336e3](https://github.com/chrisleekr/binance-trading-bot/commit/ee336e33f2ae77b421b0cfc11e5f5f4651144d93))


### Bug Fixes

* **api,db,web:** bound pool checkouts and statements, scope archive sums by quote ([#749](https://github.com/chrisleekr/binance-trading-bot/issues/749)) ([b0e951b](https://github.com/chrisleekr/binance-trading-bot/commit/b0e951b1dfc4a566574aa269379a09b33ea14415))

## [1.1.0](https://github.com/chrisleekr/binance-trading-bot/compare/v1.0.0...v1.1.0) (2026-08-15)


### Features

* archive cost-basis integrity, symbol permissions, dust cancel, discovery admission ([#735](https://github.com/chrisleekr/binance-trading-bot/issues/735)) ([0e6dbf2](https://github.com/chrisleekr/binance-trading-bot/commit/0e6dbf28de992c330978165d6886a48dfab8ee8f))
* **binance:** add a per-account ORDERS rate governor and deferrable order intents ([#734](https://github.com/chrisleekr/binance-trading-bot/issues/734)) ([4fb27ef](https://github.com/chrisleekr/binance-trading-bot/commit/4fb27efff160bf61c73535558652b2f2dbd12da3))
* **db:** store open conditions in condition_states and harden scoped repo binding ([#731](https://github.com/chrisleekr/binance-trading-bot/issues/731)) ([d84b09f](https://github.com/chrisleekr/binance-trading-bot/commit/d84b09fec20ed2dcb6af500f18d7868ebbf09a2e))
* **profile:** add on-demand profile diagnosis and discovery funnel ([#736](https://github.com/chrisleekr/binance-trading-bot/issues/736)) ([0b0295d](https://github.com/chrisleekr/binance-trading-bot/commit/0b0295d80e676166e7fbcd5aaccdce1023cc5fc7))
* **retention:** move log retention into a config table and add the log surfaces ([#733](https://github.com/chrisleekr/binance-trading-bot/issues/733)) ([7db1faf](https://github.com/chrisleekr/binance-trading-bot/commit/7db1faf050e49d1a69aaac1012570dd67353085e))
* **strategy:** add the price-outside-exchange-band protective-stop blocker ([#737](https://github.com/chrisleekr/binance-trading-bot/issues/737)) ([fb0bffc](https://github.com/chrisleekr/binance-trading-bot/commit/fb0bffc7d5d8f93514dce1730ae373898b8c2164))
* **strategy:** clamp or natively trail a protective stop Binance's price band refuses ([#741](https://github.com/chrisleekr/binance-trading-bot/issues/741)) ([5242ee7](https://github.com/chrisleekr/binance-trading-bot/commit/5242ee7f0908b7a0ba3280aa32cbb092e212a111))


### Bug Fixes

* **ci:** resolve audit and release formatting drift ([#745](https://github.com/chrisleekr/binance-trading-bot/issues/745)) ([8147787](https://github.com/chrisleekr/binance-trading-bot/commit/814778750efa2bdcd258d47a011c66c79e7ad1c3))
* **technicals:** align the rating window and vote rules with TradingView ([#739](https://github.com/chrisleekr/binance-trading-bot/issues/739)) ([a85b135](https://github.com/chrisleekr/binance-trading-bot/commit/a85b1354216c2b84d430c4c94f2d868418911292))
* **web:** hold scroll position while loading and polling, and gate phantom alert metrics ([#716](https://github.com/chrisleekr/binance-trading-bot/issues/716)) ([dbe1157](https://github.com/chrisleekr/binance-trading-bot/commit/dbe1157d6b5116a136903ed353b541e47fab1021))
* **web:** reserve height for every loading branch, gate regressions in CI ([#718](https://github.com/chrisleekr/binance-trading-bot/issues/718)) ([9d14544](https://github.com/chrisleekr/binance-trading-bot/commit/9d14544f7d1983b932167202f2558db010e0af83))
* **worker,contracts,web:** harden diagnosis ladder, discovery funnel, and signal panel ([#744](https://github.com/chrisleekr/binance-trading-bot/issues/744)) ([cdf4c1f](https://github.com/chrisleekr/binance-trading-bot/commit/cdf4c1f0bd3c62e380471284a58fa0540c22a1f7))
* **worker,contracts:** alert when a protective stop never reaches the exchange ([#740](https://github.com/chrisleekr/binance-trading-bot/issues/740)) ([f57791d](https://github.com/chrisleekr/binance-trading-bot/commit/f57791d0100cbcb360c93c30e0b3369111065dd3))
* **worker:** break the retry loop on an order Binance keeps refusing ([#742](https://github.com/chrisleekr/binance-trading-bot/issues/742)) ([ac603db](https://github.com/chrisleekr/binance-trading-bot/commit/ac603db078df0dd08ab090acdc4a0ee85f2d1427))

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
