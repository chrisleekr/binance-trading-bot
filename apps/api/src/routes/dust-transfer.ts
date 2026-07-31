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
    c.set('auditEvent', { event: 'dust-transfer', payload: { profileId, assets: body.assets } });
    return c.json({ scheduledAt: action.actionAt.toISOString(), overrideActionId: action.id }, 202);
  });

  return app;
};
