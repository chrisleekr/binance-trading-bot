# Go live

You have [installed](install.md) the bot and [configured a profile](configure.md). This page is the last step: switching that profile on to trade **real money**, safely, and knowing how to stop it.

!!! warning "Real money"

    A live profile places real buy and sell orders on your Binance account. Do a slow
    first run: one profile, a small budget, one or two coins you understand.

## Pre-flight checklist

Before you enable a live profile, confirm:

- **The API key is green.** The account's API-keys page shows a healthy status. A red key means wrong permissions or an IP allow-list mismatch — see [Troubleshooting](../operations/troubleshooting.md).
- **The Binance IP allow-list is on** (set during [install](install.md)). It is your main protection if the key ever leaks.
- **A notifier is set up.** Configure [Slack, Telegram, or a webhook](../concepts/notifiers.md) so you hear about trades and errors without watching the screen. A live profile with no notifier warns you on the dashboard, because a real-money emergency would otherwise be silent.
- **The budget is small** for the first run, and the coins are ones you understand.

## Check the Live gate

Each profile has an advisory **Live gate** — a readiness check that grades the config against your quality bars before you commit real money. It never blocks you; it just tells you whether the setup clears your own thresholds. Review it on the profile's [Live gate](../user-guide/profile/live-gate.md) section, optionally after a [backtest](../user-guide/profile/backtest.md).

## Enable the profile

A new profile starts **disabled** and holds no positions. When the pre-flight looks good, enable it from the profile's [Profile settings](../user-guide/profile/general.md) section. From then on the worker ticks the profile's coins and places orders per the strategy, starting on each coin's next price update from Binance.

Watch the first live trade land, then read what the bot did and **why** on the [Dashboard](../user-guide/dashboard.md) and the symbol's Logs tab.

## Know how to stop it

Before the first live trade, read **[Kill switch](../operations/kill-switch.md)**. It is the emergency stop — one coin, one profile, or the whole account — and that page is the single reference for where each control lives, how long it lasts, and what happens to orders already resting on Binance.

## Pausing vs deleting a profile

Separate from the kill switch, a profile has its own **enable/disable** flag. Both stop new orders; the kill switch is the fast emergency stop, disable is the normal off switch.

- **Disable a profile** — it stops making new decisions but, by design, **leaves any resting orders live** on Binance. Use this for a temporary pause.
- **Delete a profile** — this actively cancels the profile's live orders as it removes it, so it does not leave "ghost" orders behind.

## Staying safe

- **Keep the Binance IP allow-list on.**
- **Set up a [notifier](../concepts/notifiers.md)** so you hear about trades and errors without watching the screen.
- **Back up regularly** — see [Backup & restore](../user-guide/system/backup-restore.md).

## When something breaks

See **[Troubleshooting](../operations/troubleshooting.md)** for the common symptoms and fixes.
