import { asAccountId, type AccountId, type ProfileId, type UserId } from '@app/contracts';
import { accountRepo, profileRepo, type AccountRepo, type ProfileRepo, type schema } from '@app/db';
import type { Context } from 'hono';
import type { DI } from './di.js';
import { HttpError } from './middleware/error.js';
import type { Env } from './types.js';

// Narrows c.var.userId to UserId (the operator / login identity). Mounting
// requireUser() ahead of the route guarantees this is set, but TS does not see
// that; this throws on misuse.
export const userIdOf = (c: Context<Env>): UserId => {
  const u = c.get('userId');
  if (!u) throw new HttpError('UNAUTHENTICATED', 'authentication required');
  return u;
};

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Reads the `:accountId` path segment shared by every account-scoped router
 * (all mounted under `/accounts/:accountId`). Validates the shape so a malformed
 * segment is a clean 404 rather than a Postgres invalid-uuid error inside the
 * ownership query. Ownership itself is proven later by scopeAccount/scopeProfile.
 */
export const accountIdOf = (c: Context<Env>): AccountId => {
  const raw = c.req.param('accountId');
  if (!raw || !UUID_RE.test(raw)) throw new HttpError('NOT_FOUND', 'account');
  return asAccountId(raw);
};

/**
 * Resolve the authenticated operator + path :accountId + :profileId into the
 * bound, ownership-checked ProfileScope repo. `profileRepo` throws
 * ProfileNotOwnedError (mapped to 404) unless the operator owns the account AND
 * the profile lives under that account, so this is the single ownership gate —
 * no extra existence check is needed unless the handler uses the profile row
 * (then use requireOwnedProfile). profileId is passed in (already validated via
 * asProfileId at the route-typed call site) because c.req.valid('param') is
 * typed per-route and cannot be read generically here; accountId comes from the
 * router mount prefix.
 */
export const scopeOf = (c: Context<Env>, di: DI, profileId: ProfileId): Promise<ProfileRepo> =>
  profileRepo(di.db, userIdOf(c), accountIdOf(c), profileId);

/**
 * Resolve the operator + path :accountId into the bound, ownership-checked
 * AccountScope repo (account CRUD, api-key management, profile create/list).
 * `accountRepo` throws AccountNotOwnedError (mapped to 404) unless the operator
 * owns the account.
 */
export const accountScopeOf = (c: Context<Env>, di: DI): Promise<AccountRepo> =>
  accountRepo(di.db, userIdOf(c), accountIdOf(c));

/**
 * scopeOf plus the profile row, for handlers that read it. The findById guard is
 * defensive (scopeOf already proved existence; this covers a delete-between race
 * and narrows the type).
 */
export const requireOwnedProfile = async (
  c: Context<Env>,
  di: DI,
  profileId: ProfileId,
): Promise<{ p: ProfileRepo; profile: schema.ProfileRow }> => {
  const p = await scopeOf(c, di, profileId);
  const profile = await p.profile.findById();
  if (!profile) throw new HttpError('NOT_FOUND', 'profile');
  return { p, profile };
};

// Options for the `reconcile-fees` job (the worker pulls myTrades to true up a
// profile's realised fees). It MUST NOT carry a static jobId: BullMQ ignores an
// add() whose jobId still exists, and the api pipeline queue retains completed
// jobs, so a fixed id makes only the FIRST reconcile per profile ever run. A
// fresh id per enqueue (the BullMQ default) makes every request run;
// removeOnComplete bounds the completed set. The handler is idempotent, so a
// redundant reconcile is cheap. (The `reconfigure-profile` resync shares this
// no-static-jobId shape via RECONFIGURE_PROFILE_JOB_OPTS in @app/core/queue.)
export const RECONCILE_FEES_JOB_OPTS = { removeOnComplete: true, removeOnFail: { count: 1_000 } };

/**
 * Options for the `dispose-profile` job. Same no-static-jobId rule as
 * {@link RECONCILE_FEES_JOB_OPTS} (a fixed id would let only the first disposal per profile
 * ever run), but it MUST also retry: the handler's whole design is "throw until the
 * exchange is provably clear", and BullMQ runs a job exactly once unless `attempts`
 * says otherwise — so without this, one transient Binance blip sends a half-disposed
 * profile straight to the DLQ.
 *
 * The envelope is sized against a real Binance outage, not a blip. BullMQ's
 * exponential delay is `2^(attempt-1) x delay`, so these 8 attempts span
 * 5s+10s+20s+40s+80s+160s+320s ~= 10 minutes; the 5-attempt/2s pairing this started
 * as was ~30 SECONDS, which an outage exhausts trivially — leaving a profile disabled
 * and half-disposed with only a DLQ entry to say so, while the operator has already
 * been told `202`. When the attempts DO run out, the DLQ watcher's operator notify is
 * the signal (every pipeline job routes there on final failure).
 *
 * https://docs.bullmq.io/guide/retrying-failing-jobs
 */
export const DISPOSE_JOB_OPTS = {
  attempts: 8,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: true,
  removeOnFail: { count: 1_000 },
};
