// Operator guidance for the risk-config table, keyed by the field path the
// generator emits. The generator fails when these keys and the schema's leaves
// disagree, so a new risk field cannot ship undocumented.
import type { FieldNotes } from '@app/contracts';

export const riskNotes: FieldNotes = {
  dailyLossLimitQuote: {
    when: 'Set it before the first live run. Pick an amount you would be annoyed but not hurt to lose in one day — a common starting point is 2–5% of the budget this profile trades.',
    expect:
      'Once the day\'s realised loss reaches the limit the profile stops opening or adding to positions until 00:00 UTC. Positions you already hold keep running with their stops, so you are never left unhedged. The account health bar shows "paused", and warns at 80% of the limit. `0` disables the limit entirely.',
  },
  'lossStreak.maxLosingExits': {
    when: 'Turn it on when you have watched a bad hour produce three losing exits and wished the bot had stopped. 3 is a sensible first setting; 2 will pause you often on a choppy day. Every losing exit in the window counts, whether or not there were winners between them.',
    expect:
      'Once that many exits inside the lookback window have closed at a loss, new buys pause for the pause you set below. Positions you already hold keep running with their stops. Unlike the daily limit, the count does not reset at UTC midnight, so a run of losses spanning two days is still seen as one run. `0` turns this guard off.',
  },
  'lossStreak.lookbackHours': {
    when: 'Leave it at 24 unless your profile trades much faster or much slower than once a day. Shorten it if you want the guard to react only to a burst; lengthen it to catch a slow bleed.',
    expect:
      'Only exits archived inside this many hours before now are counted, so a loss ages out of the count on its own. Longer windows make the guard trip more easily, because more losses fall inside them.',
  },
  'lossStreak.pauseHours': {
    when: 'Match it to how long you think the conditions that caused the losses will last. 24 is a full day off; 4 is a breather.',
    expect:
      'New buys stay paused for this long from the moment the guard trips, and the pause is never extended while it runs. When it expires the bot re-checks the window: if the losses are still inside it, it pauses again. Selling, cancelling, and protective stops keep working the whole time.',
  },
  'drawdown.maxDrawdownQuote': {
    when: 'Set it when you care more about the total slide than about any single day — a run of small losses can drain the account without ever tripping a daily limit. Pick an amount in your quote currency you would want to stop and look at.',
    expect:
      'The bot tracks realised profit and loss across the lookback window and takes the biggest fall from a peak to a later low anywhere inside it, not how far below its best point it happens to sit right now. When that fall reaches this amount, new buys pause for the pause you set below; positions and their stops keep running. Recovering afterwards does not undo the fall: it stops counting only once it has aged out of the window. `0` turns this guard off.',
  },
  'drawdown.lookbackHours': {
    when: 'Leave it at 72 for a three-day view. Shorten it to react to a sharp slide; lengthen it to catch a slower one.',
    expect:
      'This window sets where the bot searches, not which peak it measures from. Each fall is measured from the running high just before it, so the biggest fall anywhere inside the window is the one reported, even if a later peak went higher. The peak is never an all-time high, so an old profit does not keep hiding a recent slide. A window that opens on losses is measured from flat, so it reports those losses rather than nothing.',
  },
  'drawdown.pauseHours': {
    when: 'Match it to how long you want to stay out after a drawdown. 24 is a full day off.',
    expect:
      'New buys stay paused for this long from the moment the guard trips, and the pause is never extended while it runs. When it expires the bot re-checks the window and may pause again. Selling, cancelling, and protective stops keep working the whole time.',
  },
};
