import {
  asProfileId,
  DecimalString,
  DustConversionHistory,
  type DustConversionRecord,
  DustSnapshot,
  DustTransferList,
  DustTransferRequest,
  DustTransferResponse,
  ErrorEnvelope,
  OVERRIDE_CLAIM_STALE_MS,
} from '@app/contracts';
import { profileKey } from '@app/db';
import { createRoute, z } from '@hono/zod-openapi';
import type { DI } from 'di.js';
import { HttpError } from 'middleware/error.js';
import { requireUser } from 'middleware/require-user.js';
import { scopeOf } from 'route-helpers.js';
import { createApiHono, type ApiHono } from 'types.js';

const ProfileIdParam = z.object({ profileId: z.uuid() });

const getRoute = createRoute({
  method: 'get',
  path: '/profiles/{profileId}/dust-transfer',
  tags: ['dust-transfer'],
  request: { params: ProfileIdParam },
  responses: {
    200: {
      description: 'transferable balances',
      content: { 'application/json': { schema: DustTransferList } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
    502: {
      description: 'UPSTREAM_FAILED',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
});

const historyRoute = createRoute({
  method: 'get',
  path: '/profiles/{profileId}/dust-transfer/history',
  tags: ['dust-transfer'],
  request: { params: ProfileIdParam },
  responses: {
    200: {
      description: 'past dust conversions, most recent first',
      content: { 'application/json': { schema: DustConversionHistory } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

// Map a dust-transfer override_action row to its operator-facing history record.
// `payload` (requested assets) and `result` (Binance's convertDust outcome) are
// opaque jsonb, so both are parsed defensively — a malformed blob degrades to an
// empty/absent field rather than throwing the whole list. Exported for direct
// unit testing of the defensive branches.
export const toDustConversionRecord = (row: {
  id: string;
  payload: unknown;
  result: unknown;
  processingAt: Date | null;
  consumedAt: Date | null;
  createdAt: Date;
}): DustConversionRecord => {
  const requestedAssets =
    row.payload &&
    typeof row.payload === 'object' &&
    Array.isArray((row.payload as { assets?: unknown }).assets)
      ? (row.payload as { assets: unknown[] }).assets.filter(
          (a): a is string => typeof a === 'string',
        )
      : [];
  const result =
    row.result && typeof row.result === 'object'
      ? (row.result as { totalTransfered?: unknown; transferResult?: unknown })
      : null;
  const convertedAssets =
    result && Array.isArray(result.transferResult)
      ? // Dedup: Binance may return multiple transferResult rows per source
        // asset (multiple lots), which would otherwise list an asset twice.
        [
          ...new Set(
            result.transferResult
              .map((r) =>
                r && typeof r === 'object' ? (r as { fromAsset?: unknown }).fromAsset : undefined,
              )
              .filter((a): a is string => typeof a === 'string'),
          ),
        ]
      : null;
  const bnbParsed =
    result && typeof result.totalTransfered === 'string'
      ? DecimalString.safeParse(result.totalTransfered)
      : null;
  const bnbReceived = bnbParsed && bnbParsed.success ? bnbParsed.data : null;
  const status =
    row.consumedAt !== null ? 'done' : row.processingAt !== null ? 'processing' : 'pending';
  return {
    id: row.id,
    requestedAssets,
    convertedAssets,
    bnbReceived,
    status,
    createdAt: row.createdAt.toISOString(),
    consumedAt: row.consumedAt ? row.consumedAt.toISOString() : null,
  };
};

const postRoute = createRoute({
  method: 'post',
  path: '/profiles/{profileId}/dust-transfer',
  tags: ['dust-transfer'],
  request: {
    params: ProfileIdParam,
    body: { content: { 'application/json': { schema: DustTransferRequest } } },
  },
  responses: {
    202: {
      description: 'scheduled',
      content: { 'application/json': { schema: DustTransferResponse } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const deleteRoute = createRoute({
  method: 'delete',
  path: '/profiles/{profileId}/dust-transfer',
  tags: ['dust-transfer'],
  request: { params: ProfileIdParam },
  responses: {
    204: { description: 'no queued conversion remains' },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
    409: { description: 'CONFLICT', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

export const dustTransferRouter = (di: DI): ApiHono => {
  const app = createApiHono();
  app.use('/profiles/*/dust-transfer', requireUser());
  app.use('/profiles/*/dust-transfer/history', requireUser());

  app.openapi(getRoute, async (c) => {
    const profileId = asProfileId(c.req.valid('param').profileId);
    const p = await scopeOf(c, di, profileId);
    const { accountId } = p.scope;
    // The worker's `dust-snapshot` cron writes this key from Binance's
    // `dust-btc` set — already the eligible list, so no client-side
    // threshold filtering is needed here.
    const raw = await di.redis.raw().get(profileKey({ accountId, profileId }, 'dustEligible'));
    // A `null` key is a cold cache, not an upstream failure: the cron runs
    // every 5 minutes and has not produced a snapshot yet. Surface it as an
    // empty list, the same way the technicals route treats an absent signal
    // as null, so the UI shows its neutral empty state instead of a red error.
    // Gate on `null` specifically: an empty string is a malformed payload and
    // must fall through to the `UPSTREAM_FAILED` branch below, not be masked.
    if (raw === null) return c.json([], 200);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new HttpError('UPSTREAM_FAILED', 'malformed dust-eligible json', err);
    }
    const snapshot = DustSnapshot.safeParse(parsed);
    if (!snapshot.success) {
      throw new HttpError('UPSTREAM_FAILED', 'dust-eligible snapshot failed schema validation');
    }
    return c.json(snapshot.data.assets, 200);
  });

  app.openapi(historyRoute, async (c) => {
    const profileId = asProfileId(c.req.valid('param').profileId);
    const p = await scopeOf(c, di, profileId);
    const rows = await p.overrideActions.listDustTransferHistory(50);
    // Every field is valid by construction (dates from the DB, assets filtered to
    // strings, bnbReceived pre-validated), so parse brands the output types
    // without a realistic throw — mirroring the list route's parsed serve.
    return c.json(DustConversionHistory.parse(rows.map(toDustConversionRecord)), 200);
  });

  app.openapi(postRoute, async (c) => {
    const profileId = asProfileId(c.req.valid('param').profileId);
    const body = c.req.valid('json');
    const p = await scopeOf(c, di, profileId);
    const action = await p.overrideActions.record({
      symbol: null,
      action: 'dust-transfer',
      actionAt: new Date(),
      payload: { assets: body.assets },
      triggeredBy: 'user',
    });
    // The row id, not only the assets. The cancel below hard-deletes rows and can
    // name only their ids afterwards, so without an id on this side the two halves
    // of one operator action have no key in common and a disputed cancellation
    // cannot say WHICH conversions it removed — the ids it logs would point at
    // rows that no longer exist anywhere.
    c.set('auditEvent', {
      event: 'dust-transfer',
      payload: { profileId, assets: body.assets, overrideActionId: action.id },
    });
    return c.json(
      {
        scheduledAt: action.actionAt.toISOString(),
        overrideActionId: action.id,
        createdAt: action.createdAt.toISOString(),
      },
      202,
    );
  });

  app.openapi(deleteRoute, async (c) => {
    const profileId = asProfileId(c.req.valid('param').profileId);
    const p = await scopeOf(c, di, profileId);
    // Read before the delete, because the delete's own outcome is the only reliable
    // evidence of what it skipped. `processing_at` is a lease the worker can null
    // again, so reading the column afterwards can see an unclaimed row that WAS
    // claimed while the delete ran — and answering 204 there tells the operator
    // their coins are safe while Binance is converting them. Identity survives that
    // race; the column does not.
    const target = await p.overrideActions.findActiveDustTransfer();
    // Plural: dust rows carry no symbol, so arming never supersedes a sibling and a
    // profile can hold several queued conversions. Cancelling one at a time would
    // leave the operator pressing the button until the list happened to empty.
    //
    // The horizon is the reaper's own, from the one shared constant. A claim older
    // than it belongs to a worker that died holding it, and the dust cron resets
    // exactly those rows to pending and converts them on the same pass. Leaving one
    // behind would answer this cancel 204 and spend the balance minutes later.
    //
    // One clock read for both the delete horizon and the staleness verdict below.
    // Two reads straddle two round-trips, so a claim sitting on the boundary can be
    // judged fresh by the delete and stale by the verdict — a 204 on a row the reaper
    // will convert seconds later, which is the exact answer this route must never give.
    const nowMs = Date.now();
    const staleBefore = new Date(nowMs - OVERRIDE_CLAIM_STALE_MS);
    const removedIds = await p.overrideActions.deletePendingDustTransfer(staleBefore);
    const deleted = removedIds.length;
    // Recorded before the read-back, which can throw: the rows are already hard-deleted
    // by this line, so a failure between here and the response would otherwise leave a
    // cancel with no trace anywhere. Flagged applied whenever rows actually went,
    // because the conflict branch below answers 409 after the delete has landed and the
    // middleware skips its write on 4xx. A cancel that removed nothing still logs on
    // a 204 — pressing cancel is operator intent worth keeping either way — and
    // `deleted: 0` in the payload is what tells the two apart.
    //
    // Ids and not just a count: the delete is hard, so those rows have left the history
    // the operator can read. They are dereferenceable because the arm event on this same
    // route logs the id it created alongside the asset list — the two halves of one
    // operator action share a key, so a disputed cancellation can still say which
    // conversions it removed.
    c.set('auditEvent', {
      event: 'dust-transfer-cancel',
      payload: { profileId, deleted, removedIds },
      alreadyApplied: deleted > 0,
    });
    const stillActive = await p.overrideActions.findActiveDustTransfer();
    // Nothing to evict on any branch: the dust arm writes no Redis override key, so
    // the row IS the queue. Copying the symbol route's eviction here would delete an
    // unrelated key.
    if (!stillActive) return new Response(null, { status: 204 });

    // Did the guarded delete skip the very row the operator asked about? Then it was
    // claimed at that moment whatever the column reads now. `processing_at` is still
    // consulted as well, because a row armed after the read can be claimed too.
    const survivedTheDelete = target !== null && stillActive.id === target.id;
    // A lease the worker released mid-race reads as age 0, i.e. fresh, which is the
    // safe direction: `survivedTheDelete` has already proved it was claimed.
    const claimAgeMs =
      stillActive.processingAt === null ? 0 : nowMs - stillActive.processingAt.getTime();
    if (
      (survivedTheDelete || stillActive.processingAt !== null) &&
      claimAgeMs <= OVERRIDE_CLAIM_STALE_MS
    ) {
      // The wording has to own the half-measure: the queued rows may well be gone
      // while an earlier claimed one survives, and an operator told "cancelled" stops
      // watching a conversion that is still spending their balance.
      throw new HttpError(
        'CONFLICT',
        deleted > 0
          ? 'removed the queued conversions, but the bot is already converting an earlier one; wait for its outcome before re-issuing'
          : 'the bot is already converting this dust; wait for the outcome before re-issuing it',
      );
    }
    // The survivor is unclaimed and outlived the delete, so it was armed after it: new
    // intent, not the conversion being cancelled. A stranded claim cannot reach here —
    // the delete now takes those on the reaper's horizon — so 204 no longer stands for
    // "left alone for someone else to run".
    return new Response(null, { status: 204 });
  });

  return app;
};
