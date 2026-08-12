import { Decimal } from '@app/money';
import type {
  AccountSnapshot,
  AccountSnapshotWire,
  Candle,
  PreviewInput,
  PreviewRow,
  Strategy,
  StrategyEventMap,
  TickInput,
  TickOutput,
} from './contract.js';

/**
 * The tick carries a Decimal {@link AccountSnapshot}; {@link PreviewInput.account}
 * is the wire form. Serialise each balance to decimal-strings so the gate feeds
 * `previewLevels` the same shape the SPA would.
 */
const toWireAccount = (account: AccountSnapshot): AccountSnapshotWire => ({
  balances: Object.fromEntries(
    Object.entries(account.balances).map(([asset, b]) => [
      asset,
      { free: b.free.toString(), locked: b.locked.toString() },
    ]),
  ),
  ...(account.deployedQuoteAcrossProfiles !== undefined
    ? { deployedQuoteAcrossProfiles: account.deployedQuoteAcrossProfiles }
    : {}),
});

/**
 * The decision reason the gate keys on: a place-order's `intent.reason` or a
 * cancel-order's `reason`. `null` for a decision the gate does not check (noop,
 * emit-event, set-kv).
 */
const reasonOf = (d: unknown): string | null => {
  if (typeof d !== 'object' || d === null) return null;
  const dd = d as { type?: unknown; intent?: { reason?: unknown }; reason?: unknown };
  if (dd.type === 'place-order' && typeof dd.intent?.reason === 'string') return dd.intent.reason;
  if (dd.type === 'cancel-order' && typeof dd.reason === 'string') return dd.reason;
  return null;
};

const onActionableSide = (cur: Decimal, price: Decimal, when: 'above' | 'below'): boolean =>
  when === 'above' ? cur.gte(price) : cur.lte(price);

/**
 * The CORRECTED drift gate: assert every EMITTED decision agrees with the
 * strategy's own {@link Strategy.previewLevels}. For each decision carrying a
 * reason R, gather the preview's trigger rows with `code === R` that bear a
 * `price` + `triggerWhen`; if there are any, at least one must have
 * `currentPrice` on its actionable side (`above ⇒ cur >= price`, `below ⇒ cur <=
 * price`). A reason with NO such row is EXEMPT — a price-less action (rebalance),
 * or a managed order-arm the strategy deliberately leaves untriggered.
 *
 * This is the weak `emitted ⟹ consistent` implication only. The converse
 * (`crossed ⟹ emitted`) is NOT asserted, so a decision gated on a non-price
 * condition (an EMA cross, a technicals signal, a once-per-candle guard) never
 * false-fails the gate.
 *
 * Pure and read-only: it recomputes `previewLevels` from the tick input and
 * mutates nothing. Throws a labelled Error naming R on the first disagreement.
 * `previewLevels` is computed lazily, so a tick that emits no reason-bearing
 * decision never invokes it.
 */
export const assertPreviewTickAgreement = <
  C,
  S,
  B extends Readonly<Record<string, unknown>>,
  E extends StrategyEventMap,
>(
  strategy: Strategy<C, S, B, E>,
  input: TickInput<C, S, B>,
  output: TickOutput<S, E>,
): void => {
  let rows: readonly PreviewRow[] | null = null;

  for (const decision of output.decisions) {
    const reason = reasonOf(decision);
    if (reason === null) continue;

    if (rows === null) {
      const interval = String(
        (input.config as { candleInterval?: unknown } | undefined)?.candleInterval,
      );
      const byInterval = input.market.candlesByInterval as
        Record<string, readonly Candle[]> | undefined;
      const candles = byInterval?.[interval];
      const filters = input.market.symbolInfo?.filters;
      const quoteAsset = input.market.symbolInfo?.quoteAsset;
      // Conditional spreads keep optional keys absent (not `undefined`) under
      // exactOptionalPropertyTypes.
      const previewInput: PreviewInput<C, S> = {
        config: input.config,
        state: input.state,
        entryPrice: strategy.position?.readPosition(input.state)?.avgEntryPrice ?? null,
        currentPrice: input.market.currentPrice,
        account: toWireAccount(input.account),
        ...(candles !== undefined ? { candles } : {}),
        ...(filters !== undefined ? { filters } : {}),
        ...(quoteAsset !== undefined ? { quoteAsset } : {}),
      };
      rows = strategy.previewLevels(previewInput).sections.flatMap((s) => s.rows);
    }

    const matching = rows.filter(
      (r) => r.code === reason && r.trigger === true && r.price != null && r.triggerWhen != null,
    );
    if (matching.length === 0) continue;

    const cur = new Decimal(input.market.currentPrice);
    const consistent = matching.some((r) =>
      onActionableSide(cur, new Decimal(r.price as string), r.triggerWhen as 'above' | 'below'),
    );
    if (!consistent) {
      const first = matching[0] as PreviewRow;
      throw new Error(
        `preview disagrees about where '${reason}' acts: currentPrice ${input.market.currentPrice} not ${String(first.triggerWhen)} ${String(first.price)}`,
      );
    }
  }
};
