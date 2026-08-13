# History

The **History** tab is read-only: it shows what the profile has done. It has four views (the "History view" tabs): **Archive**, **Audit**, **Logs**, and **Activity**.

**Audit** and **Logs** answer different questions and stay separate. Audit is _what you changed_ — a handful of rows a day. Logs is _what the bot did and why_ — the worker's own record, at much higher volume.

## Archive

![History Archive view](../../assets/screenshots/user-guide/profile-history-archive.png)

_The Archive view: completed trades with net-of-fee P/L, filters, and summaries. Seeded demo data, not a real account._

Completed trades with their profit and loss. Controls:

- **Period** — `All time`, `Today`, `This week`, `This month`.
- **P/L** basis toggle — **Net of fees** (profit after Binance fees) or **Gross** (before fees). Net is the honest number; run **Reconcile fees** (below) if fees look missing.
- Summaries: **P/L by exit reason** and **P/L by source**.
- **Backfill** — reconstruct trades for a symbol (enter e.g. `WLDUSDT`, press **Backfill**); reconstructed trades appear shortly.

**Columns:** Symbol · Exit · Buy · Sell · Net PnL (or PnL in gross basis) · PnL% · Fees (commission paid to Binance) · Time · row actions.

## Audit

![History Audit view](../../assets/screenshots/user-guide/profile-history-audit.png)

_The Audit view: every event the profile emitted, filterable and exportable. Seeded demo data, not a real account._

Every event the profile emitted, for tracing exactly what happened and why.

- **Events** filter across categories: Orders, Profile, Symbols, Position.
- **Export NDJSON** downloads the complete audit log regardless of the filter.
- **Columns:** Timestamp · Event.

## Logs

Why the bot acted, or why it did not. Each row is one thing the worker decided, with the structured context it recorded at the time — order ids, prices, the reason Binance rejected something. Expand **Context** on a row to see that context as raw JSON.

**Filters** — level chips (`debug`, `info`, `warn`, `error`), a symbol list, a time range (`1h`, `6h`, `24h`, `7d`, `All`, opening on 24h), and a message search applied when you press **Search**.

**Getting the rows out:**

- **Copy** on a row copies that one row as JSON.
- **Copy page** copies every row currently on screen.
- **Export NDJSON** downloads every row matching the **current filter** — not just the page, and not the unfiltered log. One JSON object per line, with the full context intact. One export stops at 500,000 rows; if there were more, the last line is `{"truncated":true,...}` instead of a log row. A capture window can pass that, so check the last line before treating a file as the whole record, and narrow the time range if it is there.

**Capture every tick.** By default the bot logs when something changes. When that is not enough, pick a duration (`15m`, `1h`, `4h`, `24h`) and press **Capture every tick**: every tick of this profile is written as a `debug` row until the window lapses on its own. It is a large amount of data, so the window is always bounded, and only one profile can be captured at a time — if another one is armed, the panel says so rather than silently taking over.

### Raw tick trace

Below the log list, collapsed until you open it. This is a direct window onto the stream the worker already writes on every tick, so it costs no storage and needs nothing armed in advance — but it is trimmed by entry count, not by age, so on a busy profile it reaches back hours rather than days. Payloads are shown unprojected: whatever the strategy recorded is what you see. When you need a window that outlives the buffer, arm capture instead of enlarging it.

How long log rows are kept, and how many trace entries are held, are set in [Settings → Log retention](../system/settings.md#log-retention).

## Activity

![History Activity view](../../assets/screenshots/user-guide/profile-history-activity.png)

_The Activity view: a merged, dashboard-style feed of recent events. Seeded demo data, not a real account._

A merged, dashboard-style feed of recent events for the profile.

## Reconcile fees

The **Fees** column and **Net of fees** P/L here are only as accurate as the commission data on file. If they look empty or too good to be true, run **Reconcile fees** to backfill the real Binance commissions — see [General → Reconcile fees](general.md#reconcile-fees).
