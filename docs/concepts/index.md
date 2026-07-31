# Concepts

This section explains the **mechanisms** behind the screens: how the bot decides, finds coins, guards your money, and proves an edge. The [User Guide](../user-guide/index.md) covers the screens and fields; this section covers _why_ they behave as they do.

A **strategy** is the rulebook one profile trades by; the other concepts here work across every strategy.

## Strategies

The three rulebooks that ship today. You pick one per profile — see [Compare & choose](strategies/index.md):

- **[Trailing Trade](strategies/trailing-trade.md)** — buys dips in steps, trails the sell up.
- **[Momentum](strategies/momentum.md)** — buys a confirmed breakout, exits on a trailing stop.
- **[Rebalance](strategies/rebalance.md)** — holds a basket at target proportions.

## Everything else

| Concept | What it explains |
| --- | --- |
| [Discovery](discovery.md) | How the bot auto-picks which coins a profile trades and rotates the set as the market moves. |
| [Technicals](technicals.md) | The technical-analysis signals (the Technical Rating) that gate buys and can fire force-sells. |
| [Account health](account-health.md) | The always-visible strip that answers "is my money OK right now". |
| [Execution modes](execution-modes.md) | Whether a profile enters with taker (market) or maker (passive limit) orders. |
| [Backtesting](backtesting.md) | How a config is replayed over historical candles, and why a backtest reads optimistic relative to live trading. |
| [Backtest metrics](backtest-metrics.md) | What each backtest number means — return, alpha, drawdown, and the risk ratios. |
| [Notifiers](notifiers.md) | The operator-global providers (Slack, Telegram, webhook) that deliver alerts. |

Where the boundaries fall: the exact per-tab fields live in the [User Guide](../user-guide/index.md); the internal tick pipeline and reliability model live under [Contributing](../contributing/index.md).
