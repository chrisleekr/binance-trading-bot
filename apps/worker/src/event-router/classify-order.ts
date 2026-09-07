// Ownership gate for execution reports, extracted from the event-stream builder so it can be unit-tested against fake repos instead of only through boot wiring.

import type { Logger } from 'pino';
import type { Redis } from 'ioredis';

import {
  accountRepo,
  AccountNotOwnedError,
  ProfileNotOwnedError,
  profileRepo,
  type Database,
} from '@app/db';
import { asProfileId, unwrapId, type AccountId, type ProfileId } from '@app/contracts';

import { createUnownedReportThrottle } from 'executor/notifier-gap-throttle.js';
import { createPlacementOwner } from 'executor/placement-owner.js';

import type { EventRouterDeps } from './event-router.js';

export interface ClassifyOrderDeps {
  /** Handle the ownership chain and the orders / manual-orders lookups run against. */
  readonly db: Database;
  /** Connection carrying the placement-ownership markers; must be the one the placement path writes to. */
  readonly redis: Redis;
  /** Sink for the fail-safe warning raised when the ownership lookup fails, and for the one raised when no evidence names an owner at all. */
  readonly logger: Logger;
  /**
   * The profiles the account's user-data stream is currently routed to, the asking one included while it is still active.
   *
   * Must NOT be answered from `profiles.enabled`. That column is the target the profile manager converges its active set to on an interval, so it moves first and the routing follows: a profile disabled in the database is still receiving reports until the next reconcile, and counting off the column would report "no sibling" for exactly the window where one is still live. It also defaults to false, so a profile created and never started would count as a sibling that cannot receive anything.
   *
   * The membership, not just the size, because the fallthrough below needs both.
   */
  readonly activeProfileIds: (accountId: AccountId) => readonly ProfileId[];
  /**
   * Whether `symbol` is one of the profile's currently subscribed markets.
   *
   * Read from the profile manager's live symbol set for the same reason the profile count is: it is what the routing was built from. Only the no-evidence fallthrough consults it, and only to decide whether adopting is safe. The positive-owner arms never do: an order a profile provably placed is its own whether or not the operator has since unbound the symbol, and refusing to close it would strand the position.
   */
  readonly isSymbolBound: (profileId: ProfileId, symbol: string) => boolean;
}

/**
 * Builds the router's `classifyOrder` gate. A factory rather than a bare function because the lookup needs a database handle, a Redis connection and a logger that only exist at boot.
 *
 * @param deps - Boot-time collaborators the returned lookup closes over.
 * @returns The gate the event router calls per execution report, resolving `own` / `sibling` / `detached` for the receiving profile.
 */
export const createClassifyOrder = ({
  db,
  redis,
  logger,
  activeProfileIds,
  isSymbolBound,
}: ClassifyOrderDeps): EventRouterDeps['classifyOrder'] => {
  const placementOwner = createPlacementOwner({ redis, logger });
  const unownedReportThrottle = createUnownedReportThrottle({ redis, logger });

  /**
   * Resolves who owns the order this execution report refers to, from the receiving profile's point of view.
   *
   * The strategy `orders` table is ACCOUNT-domain, so one lookup answers "which profile, if any, owns this id" for the whole account, with no sibling enumeration. A row whose `profile_id` is NULL is DETACHED: its profile was deleted, so no profile may fold the fill into a position that no longer exists, but the row itself must still be closed. It gets its own verdict so the router can route it to the ledger-only reconcile instead of dropping it on the floor.
   *
   * With no row, the PLACEMENT MARKER is the next evidence. The row is written after the REST placement returns and Binance pushes the report before that, so for a few hundred ms after every placement the row lookup misses for EVERY profile on the account. The placing profile stamps its id under the clientOrderId before the request goes out, so in exactly that window the marker is the one positive owner available.
   *
   * `manual_orders` is still profile-scoped and must be checked too: manual orders rest on the same account and fill on the same stream, so skipping them would re-open the leak through the manual surface.
   *
   * Any lookup failure folds to `sibling` (drop). For the money path a dropped own report is recoverable through boot reconcile or the next report, whereas adopting a foreign one is not, so erring toward drop is fail-safe. It must not fold to `detached` either, which would close a row still resting on the exchange.
   *
   * @param operatorId - Owner of the account, proving the ownership chain on every scoped lookup.
   * @param accountId - Account whose shared user-data stream carried this report.
   * @param profileId - Profile that received the report and is asking whether it may adopt the fill.
   * @param symbol - Market the report is for. Not part of any ownership lookup, which are all keyed on the order id alone; it completes the order's identity for the warning throttle, because a Binance order id is unique per symbol rather than per account, and it is what the no-evidence fallthrough tests the profile's binding against.
   * @param binanceOrderId - Exchange order id the report refers to, the key for the `orders` and `manual_orders` lookups.
   * @param clientOrderId - The order's client id, the only handle that exists before the `orders` row commits, and the placement marker's key.
   * @returns `own` to adopt the fill, `sibling` to drop it because another profile owns it or because nothing proves this one does, or `detached` to close the ledger row without adopting.
   */
  return async (operatorId, accountId, profileId, symbol, binanceOrderId, clientOrderId) => {
    const orderId = BigInt(binanceOrderId);
    try {
      const account = await accountRepo(db, operatorId, accountId);
      const row = await account.orders.findByBinanceOrderId(orderId);
      if (row) {
        if (row.profileId === null) return 'detached';
        return row.profileId === unwrapId(profileId) ? 'own' : 'sibling';
      }

      const placer = await placementOwner.ownerOf(accountId, clientOrderId);
      if (placer !== null) return placer === unwrapId(profileId) ? 'own' : 'sibling';

      const ownsManual = async (id: ProfileId): Promise<boolean> =>
        (await (
          await profileRepo(db, operatorId, accountId, id)
        ).manualOrders.findByBinanceOrderId(orderId)) !== null;
      if (await ownsManual(profileId)) return 'own';
      const accountProfiles = await account.profiles.listForAccount();
      for (const sibling of accountProfiles) {
        const siblingId = asProfileId(sibling.id);
        if (siblingId === profileId) continue;
        if (await ownsManual(siblingId)) return 'sibling';
      }

      // Nothing names an owner: no row, no marker, no manual-order row. Its routine cause is benign and by far the most common, an order this bot never placed that the operator put on the shared account by hand. The same state is also what a broken marker path looks like, meaning Redis down or slow, a lapsed TTL, or an id the keyspace cannot use.
      //
      // The verdict turns on whether a sibling exists to corrupt, because this branch answers identically for EVERY profile on the account. With more than one, `own` tells all of them to adopt the same fill, which is the cross-profile corruption this gate exists to prevent, so the honest reading of "unknown" is drop. With exactly one profile there is nobody to leak into: adopting keeps the operator's hand-placed fill in the position state that mirrors their wallet, and dropping it would silently drift that state for no safety gain.
      //
      // Read off the ACTIVE profiles, not the rows just read for the manual-order scan. A profile that is not being routed cannot answer this branch and cannot adopt anything, so counting it would drop the fill of the only profile that trades. The scan above still needs every row: a manual order rests on the exchange whether or not its profile is currently running.
      //
      // Membership as well as size, because the active set can shrink under this call. `disable` deletes from it synchronously while the callbacks it fans out to are still suspended on the lookups above, and every one of them then reads the same post-removal set. Size alone would tell the profile that was just removed and the one that survived that each is the only profile on the account, and both would adopt. Requiring the asker to still be in the set leaves at most one caller that can answer yes. The removed profile drops the report, which is the right answer for a profile that is going away: it is unwinding, and the fill is recovered by boot reconcile.
      //
      // Throttled per (account, symbol, order) rather than logged per report, because one hand-placed order emits a NEW, its TRADE partials and a terminal report to every profile at once. An operator who learns the message cries wolf will ignore the one occurrence that says the isolation control is disarmed. The symbol belongs in that identity for the same reason `orderCommissionKey` carries it: a Binance order id is unique per symbol, not per account, so two unowned orders on different symbols can share one numeric id inside the window and the second would log nothing.
      const active = activeProfileIds(accountId);
      const soleProfile = active.length <= 1 && active.includes(profileId);
      // Adoption needs the symbol to be one this profile actually trades, on top of there being no sibling. Adopting writes position state and enqueues a tick, and `enqueue` has no binding check of its own, so a hand-placed order on a coin the profile is not bound to leaves a `symbol_states` row and an operator-visible `condition_states` blocker for a coin it will never tick again. That is the exact shape migration 0094 purges, so without this the purge would not survive the operator's next hand-placed order on a single-profile deployment.
      const boundSymbol = isSymbolBound(profileId, symbol);
      const adopt = soleProfile && boundSymbol;
      if (await unownedReportThrottle.allow(`${unwrapId(accountId)}:${symbol}:${binanceOrderId}`)) {
        const prefix =
          'event-router: no orders row, placement marker or manual order names an owner for this execution report; usually an order placed by hand on this account, but also what a lost marker looks like. ';
        let outcome: string;
        if (adopt)
          outcome =
            'Adopting it: this account has no other profile to leak into, and the symbol is one this profile trades';
        else if (!soleProfile)
          outcome =
            'Dropping it: adopting is only safe for the sole profile the account stream is routed to, and this profile is not it';
        else
          outcome =
            'Dropping it: this profile is not bound to the symbol, so adopting would write position state and tick a coin it does not trade';
        logger.warn(
          {
            operatorId,
            accountId,
            profileId,
            symbol,
            binanceOrderId,
            clientOrderId,
            soleProfile,
            boundSymbol,
            // Separates the two ways `soleProfile` goes false: a sibling is genuinely routed, or this profile has itself left the routed set mid-report.
            activeProfiles: active.length,
          },
          `${prefix}${outcome}`,
        );
      }
      return adopt ? 'own' : 'sibling';
    } catch (err) {
      if (!(err instanceof ProfileNotOwnedError) && !(err instanceof AccountNotOwnedError)) {
        logger.warn(
          { operatorId, accountId, profileId, binanceOrderId, err: err },
          'event-router: order-ownership lookup failed; dropping execution report (fail-safe)',
        );
      }
      return 'sibling';
    }
  };
};
