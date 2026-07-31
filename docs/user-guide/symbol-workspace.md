# Symbol workspace

The symbol workspace is the deepest screen: one symbol inside one profile. Open it by tapping a symbol on the [profile dashboard](dashboard.md).

A header sits above four tabs and stays visible as you switch between them:

- **Symbol switcher** and shortcuts to **Config** and **Backtest**.
- **Stats strip** — last price, 24-hour change, high, low, and volume.
- **Position strip** — your current position, open orders, and unrealised P/L.
- **Tick chips** — how long ago the last strategy tick ran, and its latency.

## Trade

![Symbol workspace Trade tab](../assets/screenshots/user-guide/symbol-workspace-trade.png)

_The Trade tab: price chart, balances, manual trade, and emergency actions. Seeded demo data, not a real account._

The Trade tab shows the price chart, the balances the profile can spend on this symbol, a manual buy/sell panel, and an **Emergency actions** panel (force a trigger, cancel a queued one, pause the symbol, or stop tracking it). The **Signal** panel below the chart is the strategy's own read of the symbol right now; each strategy supplies its own, so what it says depends on which one the profile runs.

**Cancel queued override** revokes a manual action you already asked for on this symbol — a forced buy or sell, or a manual order — before the bot's next check picks it up. It never touches your balance or any order already on Binance. Confirming gives you one of three answers:

- **Cancelled.** The request went through. It is not a promise that the queue is now empty: it is also the answer when there was nothing waiting at all, and when a newer action arrived while this one was being removed. Check the panel again if you need to be sure nothing is pending.
- **Too late — the bot is already acting on it.** A check has claimed the action, so the cancel lost the race. **Read the message**: sometimes a queued action _was_ removed and an earlier claimed one survived, so the cancel partly succeeded. Watch for a follow-up notice telling you how the claimed action ended, and if none arrives within about five minutes, check the order on Binance before asking for anything else. This stays the answer until the bot finishes with the action, which can be up to ten minutes if the check that claimed it stalled.
- **An error.** Nothing was cancelled; the message names what failed.

## Orders

![Symbol workspace Orders tab](../assets/screenshots/user-guide/symbol-workspace-orders.png)

_The Orders tab: the grid ladder, resting open orders, and the recent order history. Seeded demo data, not a real account._

Open orders currently resting on Binance, and the order history for this symbol. A Trailing Trade profile also shows its **grid ladder** here — each rung, its trigger, its budget, and which ones have been taken.

## Market

![Symbol workspace Market tab](../assets/screenshots/user-guide/symbol-workspace-market.png)

_The Market tab: technicals, discovery status, order book, and recent trades. Seeded demo data, not a real account._

The technical-analysis reading, the symbol's discovery status, the live order book, and recent market trades. See [Technicals](../concepts/technicals.md).

## Logs

![Symbol workspace Logs tab](../assets/screenshots/user-guide/symbol-workspace-logs.png)

_The Logs tab: the strategy's own record of why it acted. Seeded demo data, not a real account._

Every decision the strategy logged for this symbol, plus an advanced drawer with the raw tick detail. This is where "why did it buy?" is answered.

## Symbol config

![Symbol config page](../assets/screenshots/user-guide/symbol-workspace-config.png)

_The Symbol config page: per-symbol overrides on top of the profile strategy. Seeded demo data, not a real account._

Reached from the header **Config** button. Overrides here apply to this one symbol only; everything left unset inherits the profile's [Strategy](profile/strategy.md) config.

Adding a coin checks the profile's settings against Binance's order rules for that pair. A warning on an otherwise successful add is explained in [Troubleshooting](../operations/troubleshooting.md#a-save-worked-but-warned-order-sizing-was-not-verified).
