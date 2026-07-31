# Get started

This is the ordered path from an empty server to a running bot you understand. Follow it top to bottom; no financial background is required. Each step links into the [User Guide](../user-guide/index.md) for the screen-by-screen detail.

## The path, in order

| Step | Page | What you will do |
| --- | --- | --- |
| 1 | [Install & deploy](install.md) | Deploy the app to a server, create a Binance API key, and open the dashboard. |
| 2 | [Configure your first profile](configure.md) | Create a _profile_, choose which coins to trade, and set your budget. |
| 3 | [Go live](go-live.md) | Run the pre-flight, check the live gate, and switch the profile on for real money. |

## A few words, once

These terms appear throughout the docs:

- **Profile** — one independent setup: a strategy plus the coins and budget it applies to. One Binance account can run several profiles at once.
- **Symbol / pair** — a coin measured against another, written as one word. `BTCUSDT` means "the price of Bitcoin in Tether (a US-dollar stablecoin)".
- **Strategy** — the rulebook that decides when to buy and sell. Compare the three under [Concepts → Strategies](../concepts/strategies/index.md).
- **Order** — an instruction sent to Binance to buy or sell. It may fill immediately or rest until the price reaches it.
- **Tick** — one pass of the bot over one coin, run each time a new price update for that coin arrives from Binance.

## After you are running

- The [User Guide](../user-guide/index.md) documents every screen and field.
- The [Dashboard](../user-guide/dashboard.md) is where you watch trades and read _why_ the bot acted.
- If something looks wrong, use the [kill switch](../operations/kill-switch.md) or see [Troubleshooting](../operations/troubleshooting.md).
