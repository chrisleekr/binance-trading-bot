import { assertClientOrderId, djb2Hex } from '@app/strategy-core';

/**
 * Deterministic clientOrderId for the first-buy. djb2 hash over
 * `(profileId, symbol)` keeps the id retry-stable so a retried tick
 * coalesces at Binance rather than double-spending; birthday collisions
 * sit around ~77k pairs which is far above the v1.0 single-account ceiling.
 */
export const firstBuyClientOrderId = (profileId: string, symbol: string): string =>
  assertClientOrderId(`tt-${djb2Hex(`${profileId}|${symbol}`)}-b`);

/**
 * Deterministic clientOrderId for a grid-level BUY (entry or
 * promotion). Folds the level index into the hash so adjacent levels
 * get distinct ids: a retry of level 1 must coalesce with itself but
 * never with level 2. The `-g` suffix separates the grid regime from
 * the unparameterised `firstBuyClientOrderId` ids so a transitional
 * order placed under the old code path does not coalesce with a
 * subsequent grid level by accident.
 */
export const gridBuyClientOrderId = (
  profileId: string,
  symbol: string,
  gridIndex: number,
): string => assertClientOrderId(`tt-${djb2Hex(`${profileId}|${symbol}|${gridIndex}`)}-g`);

/**
 * Deterministic clientOrderId for an operator-initiated manual order.
 * Folds the API-stamped `overrideActionId` (UUID) into the suffix so two
 * distinct manual orders never collide, while a retry of the same tick
 * (same override row) coalesces at Binance. Takes the first 8 hex chars
 * of the UUID — 32 bits of entropy bounded by the per-profile rate of
 * manual orders, comfortably collision-free at operator scale.
 */
export const manualOrderClientOrderId = (overrideActionId: string): string => {
  const compact = overrideActionId.replace(/-/g, '').slice(0, 8);
  return assertClientOrderId(`tt-${compact}-m`);
};

/**
 * Deterministic clientOrderId for a bull-pyramid strength-add. Folds the
 * add index into the hash so each add gets a distinct id, and the `-p` suffix
 * keeps the pyramid namespace separate from grid (`-g`), first-buy (`-b`), and
 * manual (`-m`) so an add never coalesces with a grid level at Binance.
 */
export const pyramidBuyClientOrderId = (
  profileId: string,
  symbol: string,
  addIndex: number,
): string => assertClientOrderId(`tt-${djb2Hex(`${profileId}|${symbol}|pyr-${addIndex}`)}-p`);

/**
 * Deterministic clientOrderId for the exchange-side protective stop. One stable
 * id per (profile, symbol) so a re-arm coalesces with itself at Binance and a
 * resting protective stop is identifiable across worker restarts (the arm tracks
 * its order purely by this id, holding no extra state). The `-x` suffix keeps it
 * out of the first-buy (`-b`), grid (`-g`), manual (`-m`), pyramid (`-p`), and
 * sell (`-s`) namespaces so it never coalesces with another order.
 */
export const protectiveStopClientOrderId = (profileId: string, symbol: string): string =>
  assertClientOrderId(`tt-${djb2Hex(`${profileId}|${symbol}`)}-x`);
