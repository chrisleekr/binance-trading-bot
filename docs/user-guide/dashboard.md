# Dashboard

The dashboard is the home screen and your live window into the bot. It has two forms that share the same layout:

- **Account overview** — every profile on the account, at a glance.
- **Profile dashboard** — one profile in focus, with its equity curve and symbols.

Switch between them with the profile selector in the top bar. Everything is designed to be read on a phone.

![Account overview dashboard](../assets/screenshots/user-guide/dashboard.png)

_The dashboard: account health, unrealised P/L, positions, market trend, and the profile roster. Seeded demo data, not a real account._

## Account overview

From top to bottom:

- **Top bar** — the account selector, the profile selector, and the theme toggle.
- **Account health bar** — worker liveness, any trading halt, and today's realised profit or loss (P/L). It stays visible on every screen; see [Account health](../concepts/account-health.md).
- **Overview → At a glance** — combined unrealised P/L (open-position profit not yet sold), open positions, and open orders across the whole account.
- **Market trend** — where BTC and ETH sit against their 50-day average, plus a breadth reading of how many coins are rising.
- **Profiles** — one row per profile with its status and P/L. Tap a row to focus it.

## Profile dashboard

Focusing a profile adds:

- **Status, "Investigate", and "Manage profile"** — enable/disable the profile, run the read-only ["why isn't it trading?" check](profile/index.md#investigate-why-isnt-it-trading), and open the tab sheet (see [Profile](profile/index.md)).
- **Health strip** — a one-line gate and edge summary; tap "Details" to expand the scorecards.
- **KPI strip** — deployed capital, exposure cap, auto-discovered symbols, holdings, and realised P/L over the last 7 days.
- **Equity curve** — the profile's value over time against a buy-and-hold benchmark.
- **Symbols** — every symbol the profile trades. Tap one to open its [Symbol workspace](symbol-workspace.md).

## "Why did it buy?" / "Why did it sell?"

Every action carries its reason. When the bot buys or sells, the log entry explains which rule fired — for example "price fell to the next grid step" or "trailing stop hit after a 3% pull-back". If a trade ever surprises you, this is the first place to look, then the symbol's [Logs tab](symbol-workspace.md#logs). If the reason does not match your expectation, re-check the profile's [Strategy](profile/strategy.md) settings.
