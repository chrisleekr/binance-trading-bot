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
import { asProfileId, unwrapId, type ProfileId } from '@app/contracts';

import { createPlacementOwner } from 'executor/placement-owner.js';

import type { EventRouterDeps } from './event-router.js';

export interface ClassifyOrderDeps {
  /** Handle the ownership chain and the orders / manual-orders lookups run against. */
  readonly db: Database;
  /** Connection carrying the placement-ownership markers; must be the one the placement path writes to. */
  readonly redis: Redis;
  /** Sink for the fail-safe warning raised when the ownership lookup fails, and for the one raised when no evidence names an owner at all. */
  readonly logger: Logger;
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
}: ClassifyOrderDeps): EventRouterDeps['classifyOrder'] => {
  const placementOwner = createPlacementOwner({ redis, logger });
  // Cross-profile isolation gate. Resolves who owns the order id this report refers to, from the receiving profile's point of view.
  //
  // The strategy `orders` table is ACCOUNT-domain, so one lookup answers "which profile, if any, owns this id" for the whole account — no sibling enumeration. A row whose `profile_id` is NULL is DETACHED: its profile was deleted, so no profile may fold the fill into a position that no longer exists, but the row itself must still be closed. It gets its own verdict so the router can route it to the ledger-only reconcile instead of dropping it on the floor.
  //
  // With no row, the PLACEMENT MARKER is the next evidence. The row is written after the REST placement returns and Binance pushes the report before that, so for a few hundred ms after every placement the row lookup misses for EVERY profile on the account — and the fallthrough below then tells each of them the order is its own. The placing profile stamps its id under the clientOrderId before the request goes out, so in exactly that window the marker is the one positive owner available.
  //
  // `manual_orders` is still profile-scoped and must be checked too: manual orders rest on the same account and fill on the same stream, so skipping them would re-open the leak through the manual surface. No match anywhere means the order is no profile's YET — this profile's own just-placed order whose row has not committed AND whose marker was lost — so process it (adoption never waits on the orders-row write). Any lookup failure folds to `sibling` (drop): for the money path a dropped own report is recoverable (boot reconcile / next report), whereas adopting a foreign one is not, so erring toward drop is fail-safe. It must not fold to `detached` either — that would close a row still resting on the exchange.
  return async (operatorId, accountId, profileId, binanceOrderId, clientOrderId) => {
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
      for (const sibling of await account.profiles.listForAccount()) {
        const siblingId = asProfileId(sibling.id);
        if (siblingId === profileId) continue;
        if (await ownsManual(siblingId)) return 'sibling';
      }
      // The branch that granted adoption with no positive owner at all is the one this incident came out of, so it is logged rather than taken in silence. Its ROUTINE cause is benign and by far the most common: an order this bot never placed, which the operator put on the shared account by hand — it has no row, no marker and no manual-order row, and every active profile logs it once. The same line is also the only signal that the marker path itself has stopped working (Redis down or slow, a lapsed TTL, an id the keyspace cannot use), which is why the benign reading is named first: an operator who learns the message cries wolf will ignore the one occurrence that says the isolation control is disarmed. Only here — the row, marker and manual-order arms all resolved a positive owner and have nothing to report.
      logger.warn(
        { operatorId, accountId, profileId, binanceOrderId, clientOrderId },
        'event-router: no orders row, placement marker or manual order names an owner for this execution report; usually an order placed by hand on this account, but also what a lost marker looks like. Processing it as own',
      );
      return 'own';
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
