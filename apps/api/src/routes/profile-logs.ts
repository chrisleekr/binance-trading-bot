// Profile-wide log surfaces: the paged reader, its NDJSON export, the symbol
// filter options, and the raw per-tick trace.
//
// These are the "why did it do that" tools. The paged reader and the export
// share one filter contract so a downloaded file always matches what was on
// screen — an export that quietly widened or narrowed the filter would be worse
// than no export, because the operator would draw conclusions from it.
//
// The trace reader is different in kind: it reads the Redis audit stream the
// worker already writes on every tick, so it has full fidelity for free but only
// as far back as the stream's trim length. Nothing is written to serve it.

import {
  ActionLogPageResponse,
  ActionLogQuery,
  ActionLogSymbolsResponse,
  asProfileId,
  ErrorEnvelope,
  TickTraceQuery,
  TickTraceResponse,
} from '@app/contracts';
import { auditStreamKey, repo, type ActionLogCursor, type ActionLogFilter } from '@app/db';
import { createRoute, z } from '@hono/zod-openapi';
import { stream } from 'hono/streaming';
import type { DI } from 'di.js';
import { requireUser } from 'middleware/require-user.js';
import { scopeOf } from 'route-helpers.js';
import { createApiHono, type ApiHono } from 'types.js';

const ProfileIdParam = z.object({ profileId: z.uuid() });

/** Page size the export walks per round-trip. Bounds peak memory to one page, not one profile's history. */
const EXPORT_PAGE = 1_000;

/**
 * Absolute cap on rows one export may emit. A deep-capture window can hold
 * millions of rows, and an unbounded download is a self-inflicted outage on a
 * single-operator box. The cap is stated in a trailing line rather than silently
 * applied, so a truncated file cannot be mistaken for a complete one.
 */
const EXPORT_MAX_ROWS = 500_000;

/**
 * Window the symbol lookup covers when the client names no bounds. Scanning a
 * whole retention horizon for distinct symbols is expensive and the filter
 * control only needs the recent ones. The export deliberately does NOT default
 * a window: an unbounded export is what the operator asked for.
 */
const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Entries one `XREVRANGE` reads while a symbol-filtered trace page is being filled. */
const TRACE_SCAN_BATCH = 200;

/**
 * Most raw entries one symbol-filtered trace page examines before it answers short. The stream interleaves every symbol of the profile, so a pair that ticks rarely can sit thousands of entries back, and an unbounded scan of a stream capped at 100,000 entries would read the whole buffer on one request. A short page still carries `oldestStreamId`, so the caller resumes the scan from where it stopped instead of concluding the symbol never ticked.
 */
const TRACE_SCAN_MAX = 2_000;

const parseCursor = (raw: string | undefined): ActionLogCursor | null => {
  if (raw === undefined) return null;
  // The contract's regex already proved the shape, so the split cannot fail
  // here; the guard exists so a future contract change cannot silently produce
  // an `undefined` bound that pages from the head forever.
  const [time, id] = raw.split('|');
  return time !== undefined && id !== undefined ? { time, id } : null;
};

// Paging keys are excluded so the export route, whose query omits them, can pass
// its own object without inventing a limit it does not use.
const toFilter = (
  q: Omit<z.infer<typeof ActionLogQuery>, 'cursor' | 'limit'>,
): ActionLogFilter => ({
  ...(q.from ? { from: new Date(q.from) } : {}),
  ...(q.to ? { to: new Date(q.to) } : {}),
  levels: q.levels,
  symbols: q.symbols,
  ...(q.source ? { source: q.source } : {}),
  ...(q.q ? { q: q.q } : {}),
});

const listRoute = createRoute({
  method: 'get',
  path: '/profiles/{profileId}/logs',
  tags: ['action-logs'],
  request: { params: ProfileIdParam, query: ActionLogQuery },
  responses: {
    200: {
      description: 'one page of profile logs, newest-first',
      content: { 'application/json': { schema: ActionLogPageResponse } },
    },
    422: {
      description: 'VALIDATION_FAILED',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const symbolsRoute = createRoute({
  method: 'get',
  path: '/profiles/{profileId}/logs/symbols',
  tags: ['action-logs'],
  request: {
    params: ProfileIdParam,
    query: z.object({ from: z.iso.datetime().optional(), to: z.iso.datetime().optional() }),
  },
  responses: {
    200: {
      description: 'distinct symbols present in the log window',
      content: { 'application/json': { schema: ActionLogSymbolsResponse } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const exportRoute = createRoute({
  method: 'get',
  path: '/profiles/{profileId}/logs/export',
  tags: ['action-logs'],
  request: { params: ProfileIdParam, query: ActionLogQuery.omit({ cursor: true, limit: true }) },
  responses: {
    200: { description: 'newline-delimited JSON of matching log rows' },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const traceRoute = createRoute({
  method: 'get',
  path: '/profiles/{profileId}/tick-trace',
  tags: ['action-logs'],
  request: { params: ProfileIdParam, query: TickTraceQuery },
  responses: {
    200: {
      description: 'raw per-tick audit entries from the Redis stream, newest-first',
      content: { 'application/json': { schema: TickTraceResponse } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

/** Shape one stored row for the wire, including the token that pages past it. */
const toWire = (r: {
  time: Date;
  id: string;
  symbol: string | null;
  level: string;
  msg: string;
  ctx: unknown;
  cursorToken: string;
}) => ({
  time: r.time.toISOString(),
  id: r.id,
  symbol: r.symbol,
  level: r.level,
  msg: r.msg,
  ctx: r.ctx,
  cursorToken: r.cursorToken,
});

/** Widest millisecond offset a JS `Date` can represent; beyond it `toISOString` throws. */
const MAX_EPOCH_MS = 8.64e15;

/** One decoded Redis stream entry, or null when the entry carried no parseable body. */
const parseTraceEntry = (
  streamId: string,
  fields: readonly string[],
): z.infer<typeof TickTraceResponse>['items'][number] | null => {
  const bodyAt = fields.indexOf('body');
  const body = bodyAt >= 0 ? fields[bodyAt + 1] : undefined;
  if (body === undefined) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    // An unparseable entry is dropped rather than 500ing the window: the point
    // of this reader is to show what IS there during an incident.
    return null;
  }
  // Outside try/catch, so a `ts` that is a number but not a representable date
  // (NaN, ±1e20) would RangeError out of `toISOString` and 500 the whole
  // window over one bad entry. Fall back to the epoch, same as a missing `ts`.
  const rawTs = parsed['ts'];
  const ts =
    typeof rawTs === 'number' && Number.isFinite(rawTs) && Math.abs(rawTs) <= MAX_EPOCH_MS
      ? rawTs
      : 0;
  return {
    streamId,
    ts: new Date(ts).toISOString(),
    symbol: typeof parsed['symbol'] === 'string' ? parsed['symbol'] : null,
    event: typeof parsed['event'] === 'string' ? parsed['event'] : 'unknown',
    decisionTypes: Array.isArray(parsed['decisionTypes'])
      ? (parsed['decisionTypes'] as string[])
      : [],
    latencyMs: typeof parsed['latencyMs'] === 'number' ? parsed['latencyMs'] : null,
    payload: parsed['payload'],
  };
};

export const profileLogsRouter = (di: DI): ApiHono => {
  const app = createApiHono();
  app.use('/profiles/*/logs', requireUser());
  app.use('/profiles/*/logs/*', requireUser());
  app.use('/profiles/*/tick-trace', requireUser());

  app.openapi(listRoute, async (c) => {
    const profileId = asProfileId(c.req.valid('param').profileId);
    const q = c.req.valid('query');
    const p = await scopeOf(c, di, profileId);
    const rows = await p.actionLogs.listPage(q.limit, parseCursor(q.cursor), toFilter(q));
    const last = rows.at(-1);
    // Null on a short page: for a keyset reader that is the only reliable
    // end-of-results signal, since a full page might still be the last one.
    const nextCursor = rows.length === q.limit && last ? `${last.cursorToken}|${last.id}` : null;
    return c.json({ items: rows.map(toWire), nextCursor }, 200);
  });

  app.openapi(symbolsRoute, async (c) => {
    const profileId = asProfileId(c.req.valid('param').profileId);
    const { from, to } = c.req.valid('query');
    const p = await scopeOf(c, di, profileId);
    const symbols = await p.actionLogs.listLoggedSymbols(
      from ? new Date(from) : new Date(Date.now() - DEFAULT_WINDOW_MS),
      to ? new Date(to) : new Date(),
    );
    return c.json({ symbols }, 200);
  });

  app.openapi(exportRoute, async (c) => {
    const profileId = asProfileId(c.req.valid('param').profileId);
    const q = c.req.valid('query');
    const p = await scopeOf(c, di, profileId);
    const profile = await p.profile.findById();
    const filter = toFilter(q);
    c.header('content-type', 'application/x-ndjson');
    // Sanitise before interpolating: a stray quote or CR/LF in a profile name
    // would break, or inject into, the header.
    const safeName = (profile?.name ?? 'profile').replace(/[^A-Za-z0-9._-]/g, '_');
    c.header('content-disposition', `attachment; filename="logs-${safeName}.ndjson"`);
    c.set('auditEvent', { event: 'export-action-logs', payload: { profileId } });
    let written = 0;
    return stream(
      c,
      async (s) => {
        // Walk by keyset rather than materialising: a deep-capture window holds
        // orders of magnitude more rows than the audit export this replaced, and
        // building the array first is how that export would OOM the box.
        let cursor: ActionLogCursor | null = null;
        for (;;) {
          const rows = await p.actionLogs.listPage(EXPORT_PAGE, cursor, filter);
          for (const r of rows) {
            await s.write(`${JSON.stringify(toWire(r))}\n`);
            written += 1;
          }
          const last = rows.at(-1);
          if (rows.length < EXPORT_PAGE || !last) break;
          cursor = { time: last.cursorToken, id: last.id };
          if (written >= EXPORT_MAX_ROWS) {
            // A full final page proves nothing about what follows it, so ask for
            // one more row before claiming truncation — the cap is an exact
            // multiple of the page size, so the common case of a complete export
            // lands here too and must not be labelled incomplete.
            const more = await p.actionLogs.listPage(1, cursor, filter);
            if (more.length > 0) {
              // Say so in-band. A silently truncated export reads as a complete
              // one, and the operator would conclude the missing rows never
              // existed.
              await s.write(
                `${JSON.stringify({ truncated: true, written, limit: EXPORT_MAX_ROWS })}\n`,
              );
            }
            break;
          }
        }
      },
      async (e, s) => {
        // Without this arm hono swallows the throw and closes the stream
        // cleanly, so a half-written file arrives as a complete HTTP 200 — the
        // exact failure this export exists to rule out. The headers are long
        // gone, so the only channels left are an in-band marker and aborting
        // the transfer so the client's download also fails.
        await s.write(
          `${JSON.stringify({ error: 'EXPORT_FAILED', reason: e.message, written })}\n`,
        );
        s.abort();
      },
    );
  });

  app.openapi(traceRoute, async (c) => {
    const profileId = asProfileId(c.req.valid('param').profileId);
    const { symbol, limit, before } = c.req.valid('query');
    const p = await scopeOf(c, di, profileId);
    const key = auditStreamKey(p.scope.accountId, p.scope.profileId);
    const redis = di.redis.raw();
    const [streamLen, retention] = await Promise.all([
      redis.xlen(key),
      repo.retentionConfig.get(di.db),
    ]);
    // `limit` counts entries returned, not entries read. Filtering one read of `limit` entries instead answered a symbol query with whatever share of the newest window that pair happened to own, usually nothing on a profile trading a dozen pairs. Unfiltered, the first read already holds `limit` entries, so the loop runs once.
    const budget = symbol ? TRACE_SCAN_MAX : limit;
    const items: z.infer<typeof TickTraceResponse>['items'] = [];
    // The last entry EXAMINED, not the last one returned, so the next page resumes after everything this one already looked at rather than re-reading the entries it filtered out.
    let oldest: string | null = null;
    let scanned = 0;
    // Set when a read came back short, which means it reached the start of the stream: there is nothing older to resume into, so the cursor is withheld rather than inviting a page that can only be empty.
    let exhausted = false;
    while (items.length < limit && scanned < budget) {
      const count = symbol ? Math.min(TRACE_SCAN_BATCH, budget - scanned) : limit;
      // XREVRANGE, not XREAD: this is a read-only window over entries the drainer owns, and it must not touch the consumer group's delivery state. `(` makes the bound exclusive so paging cannot repeat the entry it resumed from.
      const end = oldest !== null ? `(${oldest}` : before === undefined ? '+' : `(${before}`;
      const raw = (await redis.xrevrange(key, end, '-', 'COUNT', count)) as [string, string[]][];
      for (const [id, fields] of raw) {
        scanned += 1;
        oldest = id;
        const entry = parseTraceEntry(id, fields);
        if (entry !== null && (!symbol || entry.symbol === symbol)) items.push(entry);
        if (items.length === limit) break;
      }
      // A full page stops the scan before the rest of this read was examined, so only a short read whose entries were all examined has reached the start of the stream.
      if (items.length === limit) break;
      if (raw.length < count) {
        exhausted = true;
        break;
      }
    }
    return c.json(
      {
        items,
        oldestStreamId: exhausted ? null : oldest,
        // The stream sitting at its configured cap is what proves older entries
        // were dropped — that is a different fact from "nothing happened then",
        // and conflating them would have an operator conclude the bot was idle
        // when the record is simply gone. A short read cannot stand in for it:
        // a young stream that was never trimmed reads short too, and reporting
        // loss there sends triage after entries that never existed. `>=`
        // because `XADD MAXLEN ~` trims at node boundaries, so a trimmed stream
        // usually sits somewhat above the cap.
        truncated: streamLen >= retention.auditStreamMaxlen,
      },
      200,
    );
  });

  return app;
};
