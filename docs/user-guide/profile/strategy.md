# Strategy

![Strategy section](../../assets/screenshots/user-guide/profile-strategy.png)

_The Strategy section, shown here for a Momentum profile. Every field maps to a row in the configuration reference for the chosen strategy. Seeded demo data, not a real account._

The **Strategy** section is where you pick the strategy the profile runs and set all of its knobs. The form is generated from the selected strategy's schema, so you only ever see fields that apply to that strategy, and the labels match its reference page exactly.

Pick the strategy that matches what you expect the market to do, then configure it on its reference page:

- **[Trailing Trade](../../concepts/strategies/trailing-trade.md#configuration)** — buys dips in steps and trails the sell up; for a coin that swings within a range.
- **[Momentum](../../concepts/strategies/momentum.md#configuration)** — buys a confirmed breakout and rides it out on a trailing stop; for a coin already moving up.
- **[Rebalance](../../concepts/strategies/rebalance.md#configuration)** — holds a basket at target proportions, or (in momentum weight mode) rotates into the strongest few.

Each reference page carries the full, always-current field table for that strategy — the same fields, labels, and help you see in this section.

Saving checks your settings against Binance's own order rules for every coin on the profile. A save that goes through with a warning instead of an error is explained in [Troubleshooting](../../operations/troubleshooting.md#a-save-worked-but-warned-order-sizing-was-not-verified).

## Per-symbol overrides

Some fields can be overridden per coin from the symbol screen, while the rest stay profile-wide. Each strategy page notes which fields are overridable (for example momentum allows overrides on everything except `candleInterval` and `accountCap`). An override is a separate, smaller form driven by the strategy's override schema.

## Changing strategy later

You can change a profile's strategy, but a strategy switch resets the config to that strategy's defaults — there is no automatic translation between two strategies' knobs. Backtest the new setup before enabling it.
