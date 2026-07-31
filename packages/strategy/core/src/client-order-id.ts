// Shared clientOrderId length guard. Binance's clientOrderId regex is
// `^[A-Za-z0-9._:/-]{1,36}$`; an over-length id dead-ends the order at the
// exchange, a silent rejection, the no-silent-failure invariant. Every
// strategy's id builders run `assertClientOrderId` so a too-long id surfaces
// as a loud throw, never a silent exchange-side reject or a hash silently
// sliced (which would destroy its retry-coalescing collision properties).

/** Binance's clientOrderId maximum length. */
export const BINANCE_CLIENT_ORDER_ID_MAX = 36;

/**
 * djb2 hash over ASCII bytes, returning 8 hex chars. The single home for the
 * order-id collision primitive every strategy uses to compress an identity
 * (profile, symbol, level, candle) into a Binance-legal `clientOrderId` suffix
 * without `crypto`, which the strategy packages may not import. `>>> 0` pins
 * the result to 32 bits so `toString(16)` is at most 8 hex chars. Pure and
 * stable: the same input always yields the same suffix, which is what makes a
 * retried tick coalesce at Binance instead of double-placing (invariant #2).
 * Shared so two strategies cannot silently drift to different collision
 * properties for the same contract.
 */
export const djb2Hex = (input: string): string => {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
};

/**
 * Assert a clientOrderId fits Binance's length limit and return it unchanged.
 * Throws on an over-length id rather than letting the exchange reject it.
 */
export const assertClientOrderId = (id: string): string => {
  if (id.length > BINANCE_CLIENT_ORDER_ID_MAX) {
    throw new Error(
      `clientOrderId exceeds Binance ${BINANCE_CLIENT_ORDER_ID_MAX}-char limit: ${id}`,
    );
  }
  return id;
};
