# Profile

A **profile** is one independent trading setup inside an account: its own strategy, its own coins, its own risk limits, and its own on/off switch. One Binance account can run several profiles at once — for example a cautious grid on BTC in one profile and a momentum breakout basket in another — each with its own settings but sharing the account's wallet and API key.

![Profile overview](../../assets/screenshots/user-guide/profile-overview.png)

_A profile in focus on the dashboard: status, health, KPIs, equity curve, and its symbols. Click any screenshot to zoom. Seeded demo data, not a real account._

This section documents every tab you see when you open a profile, in the order they appear in the sidebar. Each page lists the exact fields and labels the app shows, so you can configure with the doc open beside the screen.

## The profile tabs

Open the **Manage profile** sheet from the profile dashboard to reach every tab. The sheet groups them under **Configure**, **Analyze**, and **Operate** — the same grouping used below.

![Manage profile slide-over](../../assets/screenshots/user-guide/manage-profile-sheet.png)

_The "Manage profile" sheet is the launcher for every profile tab, plus the Reconcile fees action. Seeded demo data, not a real account._

| Tab | What you set there |
| --- | --- |
| **[Strategy](strategy.md)** | Which strategy runs and all of its config knobs. |
| **[Risk](risk.md)** | Account-wide safety limits: daily loss cap, max positions, exposure. |
| **[Live gate](live-gate.md)** | The advisory readiness check shown before you go live. |
| **[Discovery](discovery.md)** | Optional auto-rotation of coins in and out of the profile. |
| **[Notifications](notifications.md)** | Where alerts are sent, and which events fire one. |
| **[Backtest](backtest.md)** | Replay the strategy over history before trading it. |
| **[History](history.md)** | The profile's past orders and actions, read-only. |
| **[Bulk order](bulk-order.md)** | Place one manual order across every coin in the profile. |
| **[General](general.md)** | Rename, enable, stop, reconcile fees, and delete the profile. |

## Enabling a profile

A new profile starts **disabled** and holds no positions. You configure the strategy and risk, optionally check the [Live gate](live-gate.md), then enable it from the [General](general.md) tab. While enabled, the worker ticks the profile's coins and places orders per the strategy. Disabling stops new decisions but, by design, leaves any resting Binance orders in place — see [General](general.md) for the difference between disabling, stopping, and deleting.
