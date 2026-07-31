import { Decimal } from '@app/money';
import type { AccountSnapshot } from './contract.js';

/**
 * Parse a money value (config field or wire balance) to a finite Decimal, or
 * null. The live worker reads stored config unparsed, so any field may be
 * absent, blank, malformed, or non-finite; a null lets the caller fail safe
 * instead of throwing inside a pure tick(). Non-finite (`Infinity`) is rejected
 * so it never propagates into sizing math.
 */
export const decOrNull = (raw: unknown): Decimal | null => {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  if (raw === '') return null;
  try {
    const d = new Decimal(raw);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
};

/**
 * Account equity in quote terms: free + locked quote cash plus the cost-basis of
 * every open position across the account's same mode + quote profiles (the
 * worker-scoped deployed total). Cost-basis, not mark-to-market (the value the
 * account seam provides), so an underwater position still counts at full cost
 * and a reserve cap errs conservative. A missing balance or deployed total reads
 * as zero.
 *
 * The `free`/`locked` ctor coerces whether the boundary handed a Decimal (the
 * worker's revived balances) or a decimal-string (the wire format some callers
 * and tests pass). The ctor is guarded so a malformed leg degrades the cash to
 * zero rather than throwing inside a pure tick().
 */
export const accountEquity = (account: AccountSnapshot, quoteAsset: string): Decimal => {
  const bal = account.balances[quoteAsset];
  let cash = new Decimal(0);
  if (bal) {
    try {
      cash = new Decimal(bal.free).add(new Decimal(bal.locked));
    } catch {
      cash = new Decimal(0);
    }
  }
  return cash.add(decOrNull(account.deployedQuoteAcrossProfiles) ?? new Decimal(0));
};

/**
 * The wallet's free quantity of `asset`, or `undefined` when the snapshot could
 * not be read.
 *
 * Unreadability is an explicit fact (`account.readable`), never inferred from an
 * empty map — an empty-but-readable wallet is a KNOWN zero, not ignorance. Three
 * cases, and collapsing them is how an exit gets suppressed or a phantom
 * position gets sold:
 *
 * - **`!readable`** — UNKNOWN. A cold or malformed `account-info` could not be
 *   loaded. Callers must fail OPEN on their tracked position rather than refuse
 *   to exit or to protect it.
 * - **Line present** — its `free` (which may legitimately be zero, e.g. every
 *   coin locked into a resting SELL). Trust it.
 * - **Line absent in a readable snapshot** — a KNOWN zero. Binance's account
 *   endpoint reports `free` AND `locked` per asset, so base locked by a resting
 *   order still comes back as a present line; an absent line asserts we hold
 *   none of that asset. An empty-but-readable wallet holds none of anything.
 */
export const freeBalance = (account: AccountSnapshot, asset: string): Decimal | undefined => {
  if (!account.readable) return undefined;
  const line = account.balances[asset];
  // Constructed rather than returned as-is: not every producer runs the revival
  // boundary, so `free` may still be the raw wire value some fixtures pass as a
  // string. This revives that, nothing more — a malformed value still throws.
  return line !== undefined ? new Decimal(line.free) : new Decimal(0);
};

/** The base a SELL or a stop-arm may size against, read through {@link freeBalance}. */
export interface SizableBase {
  /** Wallet free base; `undefined` when the snapshot is unreadable. */
  readonly free: Decimal | undefined;
  /** `ownLocked` capped by the wallet's `locked`, so a filled stop is not credited. */
  readonly reclaimable: Decimal;
}

/**
 * Resolve the wallet's view of the base available to a SELL, including how much
 * of our OWN resting SELL's locked base may be credited back on top of `free`.
 *
 * The credit is capped by the wallet's `locked`, not by `openOrders`, because the
 * two disagree in exactly one dangerous way. A resting STOP_LOSS_LIMIT puts its
 * base in `locked`, so a genuinely-resting own stop shows there and `locked ≥
 * ownLocked` ⇒ the credit is the full `ownLocked`, unchanged. But `getAccount` is
 * fetched with zero balances included, so a filled/sold-out asset comes back as a
 * PRESENT line `free:0, locked:0` — not an absent one — while a stale `openOrders`
 * snapshot (missed executionReport) still lists the order. Keying on line presence
 * would credit that filled stop's `ownLocked` against a zero `locked` and size a
 * sell of coins that are gone, a -2010 on every tick. `min(ownLocked, walletLocked)`
 * trusts whichever view holds less base.
 */
export const sizableBase = (
  account: AccountSnapshot,
  asset: string,
  ownLocked: Decimal,
): SizableBase => {
  const line = account.balances[asset];
  const free = freeBalance(account, asset);
  const walletLocked = line === undefined ? new Decimal(0) : new Decimal(line.locked);
  return { free, reclaimable: Decimal.min(ownLocked, walletLocked) };
};
