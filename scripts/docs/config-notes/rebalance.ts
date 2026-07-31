// Operator guidance for the Rebalance config table, keyed by the field path the
// generator emits. Keys must match the schema's leaves exactly.
import type { FieldNotes } from '@app/contracts';

export const rebalanceNotes: FieldNotes = {
  enabled: {
    when: 'Leave off until you have backtested the basket you intend to hold. Turn it on when you want the profile to maintain target weights rather than trade signals.',
    expect:
      'Off, the profile does nothing at all — no buys, no sells, no drift correction. On, every tick compares your holdings to the targets and trades the gap.',
  },
  weightMode: {
    when: 'Use `fixed` when you already know the split you want (say 60% BTC / 40% ETH). Use `momentum` when you want the basket to follow whatever has been strongest recently.',
    expect:
      'In `fixed` mode the weights you type are the targets. In `momentum` mode your target list is only the candidate pool: it is ranked by trailing return and the top few are held at equal weight, so the weights you typed are ignored and the basket contents change over time.',
  },
  candleInterval: {
    when: 'Match it to how often you want the basket re-checked. `1h` or `4h` suits a slow basket; `1d` is close to a monthly-rebalance discipline.',
    expect:
      'Shorter intervals check drift more often, so the basket tracks target more tightly but trades more and pays more fees. Longer intervals let drift run further before correcting.',
  },
  driftThreshold: {
    when: 'Raise it when the basket is churning on small moves and eating fees. Lower it when you want holdings kept tight to target.',
    expect:
      'Nothing trades until a holding is off target by more than this. At the `0.05` default a 60% target is left alone between 55% and 65%. Halving it roughly doubles rebalance frequency.',
  },
  minTradeQuote: {
    when: 'Raise it if you see lots of tiny corrective orders. It must stay at or above the exchange minimum order size for your pairs, or the trades will simply be rejected.',
    expect:
      'Corrections smaller than this are skipped entirely, so small drifts accumulate until they are worth trading. Set too high, the basket never corrects at all.',
  },
  basketBudgetQuote: {
    when: 'Set it to the amount of cash you want deployed into the basket. Leave at `0` only if the coins are already bought and you just want the weights maintained.',
    expect:
      'The strategy spends free cash up to this total across the targets, then holds the weights. At `0` it never spends cash — a common surprise when a new basket appears to do nothing.',
  },
  'momentum.lookbackCandles': {
    when: 'Only relevant in `momentum` weight mode. Shorten it to chase recent strength, lengthen it to rank on a steadier trend.',
    expect:
      'Short lookbacks rotate the basket often and whipsaw in choppy markets. Long lookbacks are slower to drop a coin that has already turned. `30` candles on a `1h` interval is about 30 hours of trailing return.',
  },
  'momentum.topK': {
    when: 'Only relevant in `momentum` weight mode. Raise it to spread across more coins, lower it to concentrate in the strongest.',
    expect:
      'The top K by trailing return are held at equal weight; everything else in the list rotates to cash. A small K concentrates risk and rotates more violently; a large K approaches simply holding the whole list.',
  },
  'targets[].symbol': {
    when: "Always. Every basket member is listed here, and each one must also be in the profile's symbol list or it will never be traded.",
    expect:
      "A symbol listed here but absent from the profile's symbols is silently never traded, which reads as the basket ignoring part of your target.",
  },
  'targets[].weight': {
    when: 'Always in `fixed` mode. Ignored in `momentum` mode, where equal weights across the top K are used instead.',
    expect:
      'The share of the basket this coin should hold. Weights across all targets must sum to at most 1; summing to less than 1 deliberately leaves the remainder in cash.',
  },
};
