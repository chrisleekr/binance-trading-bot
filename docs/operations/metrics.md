# Metrics reference

Every series the worker can export, and what each one measures. This is the vocabulary the [alert rules](deploy.md#alert-rules) are written in: if a name is not on this page, no rule can read it.

**Where to scrape it.** The worker exposes `/metrics` on its own admin listener (`WORKER_ADMIN_PORT`, default `9101`), the api on `ADMIN_PORT` (default `9100`). Both bind to `127.0.0.1` by default and are unauthenticated — see [Alert rules](deploy.md#scrape-config-the-rules-assume) for the bind and scrape config Prometheus needs, and why neither port belongs in `ports:`.

**The catalogue is closed.** The worker records through a sink that accepts only the names below, so a typo cannot spawn a new series and an ad-hoc metric cannot appear without a catalogue entry. The table is generated from that catalogue, and the `What it measures` column is the same `HELP` text the scrape carries, so this page and `/metrics` cannot disagree.

**Cardinality is bounded by your own deployment.** One series per (profile, symbol) for the tick metrics, one per Redis audit stream for the audit metrics, one per account for the Binance user-data stream metrics, one per queue for the BullMQ depth gauge. The Postgres pool gauges carry no labels at all — one series each, per process.

!!! note "A counter you read as a level will mislead you"

    Counters only go up, and a worker restart puts them back to zero. Read them with `rate()` or `increase()` over a window, never as a raw value. Several are also seeded at zero the first time a stream is touched: without that seed a first-ever incident is a series that appears already at its final value, which `increase()` reads as no change at all.

    Gauges are last-value-wins and are the opposite trap: one that stops being written keeps exporting its last sample for the life of the process. `audit_consumer_lag` behaves that way for a stream that stops being probed.

--8<-- "docs/\_generated/config/metrics.md"

## Process and runtime metrics

Not in the table above, because the worker does not declare them: `process_*` and `nodejs_*` come from prom-client's default collectors, and `up` is synthesised by Prometheus itself, one series per scrape target. `WorkerDown` reads `up`; nothing in this repo writes it.
