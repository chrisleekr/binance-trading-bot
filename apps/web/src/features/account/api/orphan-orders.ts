// Orphan-orders queries. The list endpoint returns the worker's current orphan
// snapshot (orders open on Binance that no profile tracks) plus the DERIVED
// owning profile; the POST hands one back to that owner. The destination is never
// chosen by the client — the clientOrderId already says who placed the order.

import {
  AdoptOrphanResponseSchema,
  OrphanOrdersResponseSchema,
  type AdoptOrphanRequest,
  type AdoptOrphanResponse,
  type OrphanOrdersResponse,
} from '@app/contracts';

import { apiFetch } from '@/shared/lib/api';
import { accountPath } from '@/shared/lib/account-scope';

/**
 * Fetch the current orphan-order set with per-orphan owning-profile hints and
 * the operator's profile list. Served from the worker's Redis snapshot, so a
 * cold cache returns an empty list with `computedAtMs: null` rather than an
 * error — the frontend renders that as a neutral "nothing untracked" state.
 */
export const fetchOrphanOrders = (): Promise<OrphanOrdersResponse> =>
  apiFetch(accountPath('/orphan-orders'), OrphanOrdersResponseSchema, { method: 'GET' });

/**
 * Hand one orphan order back to the profile that placed it: the API derives the
 * owner from the clientOrderId, inserts a tracked row in that strategy's own slot,
 * and subscribes the symbol so it resumes managing the order. 409s when no profile
 * (or more than one) can prove it placed the order, and on a second adopt.
 */
export const adoptOrphanOrder = (body: AdoptOrphanRequest): Promise<AdoptOrphanResponse> =>
  apiFetch(accountPath('/orphan-orders/adopt'), AdoptOrphanResponseSchema, {
    method: 'POST',
    body,
  });
