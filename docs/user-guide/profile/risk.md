# Risk

![Risk section](../../assets/screenshots/user-guide/profile-risk.png)

_The Risk section. Caps that stop the strategy before a loss compounds. Seeded demo data, not a real account._

The **Risk** section sets safety limits that apply on top of whatever the strategy decides. They are circuit breakers: the strategy proposes trades, and these limits can veto or size them down. All limits are optional — a `0` or blank value turns that limit off.

The fields, labels, and help below are generated from the same schema the section renders, so they match what you see on screen exactly.

--8<-- "docs/\_generated/config/risk.md"

## How the limits interact

- A **daily loss limit** stops opening or adding to positions once the day's realised loss reaches it; open positions and their stops keep running so you are never left unhedged. It resets at the start of the next UTC day.
- A **loss-streak guard** stops new buys once that many exits inside its lookback window have closed at a loss. It counts every losing exit in the window, not only losses that came one after another, so a winning exit between two losses does not reset it. The window rolls, so unlike the daily limit it still sees losses that started yesterday and finished today. Off by default.
- A **drawdown guard** stops new buys once realised profit and loss has fallen that far from a peak to a later low anywhere inside its lookback window — the worst fall in the window, not the fall as of right now, so recovering afterwards does not undo it until it ages out. That is the one that catches a slide built from many small losses, none of which would ever reach a daily limit. Off by default.
- All three of the breakers above only **pause new buys**. None of them sells anything, and none of them touches your protective stops — an open position always keeps its exit. The daily limit lifts at the next UTC day; each guard lifts after the pause you configured, measured from the moment it tripped.
- A **max open positions** limit keeps a profile from holding more than that many coins at once. While it holds that many, a new buy on a coin it does not already hold is dropped, and the coin can be bought on a later signal once a slot frees up. Buying more of a coin it already holds, selling, stops and cancels are never affected. Off by default (0).
  - It is enforced by the live worker only. Backtests and replays do not apply it, so a backtest of a profile that relies on it can open more coins than the live profile would.
  - A buy you place yourself with a manual override is exempt, because it is an explicit order from you.
  - It fails open: if the bot cannot read its holdings for a tick, that tick's buy goes through rather than blocking trading.
  - It counts the bot's own records, never the wallet, so leftover dust does not use up a slot. A coin counts while the bot has a cost-basis record for it, a buy order resting on it, or a buy that filled in the last 15 minutes (the cost-basis record is written a moment after a fill). A coin that was bought and sold within those 15 minutes can still count briefly, which only delays the next buy.
  - Two coins signalling at the same candle close cannot both take the last slot: the worker handles one profile's buys one at a time.
- **Exposure and position caps** are checked before a buy is sized, so a strategy that wants to deploy more than a cap allows is trimmed to fit, not blocked outright.
- These limits are profile-scoped. Running several profiles on one account means their limits are independent; the account wallet is still shared, so size them with the whole account in mind.
