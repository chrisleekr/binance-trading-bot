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
};
