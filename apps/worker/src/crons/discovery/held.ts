// Wallet-held check for the discovery reap guard.

import { Decimal } from '@app/money';

/**
 * Whether the wallet holds at least the symbol's `minQty` lot floor of its base
 * asset (free + locked, already summed into `wallet`). `minQty` not
 * `minNotional` is the floor: a balance that clears `minQty` but not the order
 * value floor is unsellable dust, and this treats it as held so discovery never
 * reaps it. Deliberately conservative — the cost is a discovery slot pinned by
 * sub-`minNotional` dust; the benefit is never orphaning a real position. Pure
 * so the reap held-decision is unit-testable without Binance. Throws (via
 * decimal.js) on a non-numeric `minQty`; the caller wraps and fails safe.
 */
export const baseAssetHeld = (
  wallet: Record<string, Decimal>,
  baseAsset: string,
  minQty: string,
): boolean => (wallet[baseAsset] ?? new Decimal(0)).gte(new Decimal(minQty));
