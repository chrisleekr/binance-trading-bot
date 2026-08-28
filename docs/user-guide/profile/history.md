# History

The **History** section is read-only: it shows what the profile has done. It has four views (the "History view" tabs): **Archive**, **Audit**, **Logs**, and **Activity**.

**Audit** and **Logs** answer different questions and stay separate. Audit is _what you changed_ — a handful of rows a day. Logs is _what the bot did and why_ — the worker's own record, at much higher volume.

## Archive

Completed trades with their profit and loss. Controls:

- **Period** — `All time`, `Today`, `This week`, `This month`.
- **P/L** basis toggle — **Net of fees** or **Recorded**. Recorded uses the stored cost-basis result; Net also applies fees not already included there. Net appears only when fee evidence is complete.
- Summaries: **P/L by exit reason** and **P/L by source**.
- **Recover a specific coin** — a collapsed section for a coin that is missing from the list below and from the notices above it (enter e.g. `WLDUSDT`, press **Backfill**); reconstructed trades appear shortly. Safe to re-run, and the coin need not still be trading.

**Columns:** Symbol · Exit · Buy · Sell · Net P/L (or Recorded P/L) · P/L% · Fees (commission paid to Binance) · Time · row actions. P/L% uses the same basis as the amount beside it, so both change together. When the selected basis is available, the **% of P/L** shares in each summary — **P/L by exit reason** and **P/L by source** — add up to 100 for one quote coin (the coin you spend, e.g. USDT) whenever that coin has any P/L. The two summaries are counted separately, so their percentages are not meant to be added together; an all-zero line in either summary shows `0%`. If the period covers trades priced in more than one quote coin, each share names its own coin — **25% of USDT P/L** — because each coin is counted to 100 on its own and the lines are not shares of one shared total. With a single coin the shares stay the plain **% of P/L**. An incomplete Net group shows `net n/a` in place of each share instead of a made-up split; a screen reader reads that mark as **Share of P/L unavailable, <coin> fee evidence incomplete**. One incomplete line withholds every share for that quote coin, so a complete line in the same coin loses its share too, but keeps its own amount. Only the incomplete line's amount reads `net n/a`. Precision: P/L% always reads at 2 decimal places, Buy, Sell and Fees show up to 8 so a fraction-of-a-coin amount stays visible instead of reading as zero, and the P/L amount reads at 2 decimal places from 1 upward and up to 8 below it.

**On a phone** those nine columns will not fit, so each trade becomes a two-line row instead: the coin and its profit or loss on the first line, why it closed and when on the second. Tap a row to open a panel with the full figures — Buy, Sell, P/L, P/L%, fees and the archived time. The **⋮** button at the end of each row is the same actions menu as on a wide screen, **Delete** included. Nothing is dropped by the narrower layout; it is the same trades, one tap deeper.

### When history is incomplete

Two notices can appear above the trades, and they mean different things.

- **Trade history incomplete** (a yellow warning) — these coins have fills on Binance but no saved profit/loss here. **While the profile is running**, the bot retries them by itself every 15 minutes, so they usually clear without you doing anything. A **paused profile is not swept**, so nothing retries until you resume it — press **Recover all** to repair it now, and press it any time you would rather not wait for the next pass.
- A quieter grey note lists coins a recovery already tried and could not rebuild, each with its reason: no closed buy → sell cycle yet, sold without a recorded buy, sold more than was bought here, or Binance no longer lists the coin. There is nothing to do about those, so there is no button — **✕** hides one and **Show hidden** brings it back.

A trade can read `n/a` in place of its profit or loss, with an em-dash where the percentage would be — in the P/L% column on a wide screen, in the tap-to-open panel on a phone. A plain `n/a` means the bot has no record of what the coin originally cost, so it cannot work out the profit or loss. It is the only mark that means unrecoverable history: a P/L amount withheld for incomplete fee evidence reads `net n/a` instead. Other things that fault withholds read differently, so do not read them as empty: the P/L% cell shows an em dash, and each summary line's statistics say **Net statistics unavailable, fee accounting incomplete**. A screen reader reads that mark as **P/L unavailable**. On those rows the **Buy** and **Sell** figures count only the part it could match, so they read low too, and the summaries above count the trade as zero. It is an unmeasured trade, not a break-even one.

A row marked `net n/a` is the other fault: the fee evidence is incomplete, so only the Net figure is withheld. A screen reader reads that mark as **Net P/L unavailable**. Recorded P/L and raw **Fees** remain visible, but Net rollups and derived statistics are withheld. Zero alone does not prove completeness because a BUY fee already included in cost basis can require no additional adjustment.

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

If a row or a summary line is marked `net n/a`, run **Reconcile fees**; a summary can carry the mark when the incomplete trade is not on the page you are looking at, because the summaries cover the whole period while the list is paged. see [Profile settings → Reconcile fees](general.md#reconcile-fees).
