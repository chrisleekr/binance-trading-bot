// The operator's "why did it do that" surfaces: the paged reader, its NDJSON
// export, the symbol filter options, and the raw per-tick trace.
//
// What is worth proving here rather than at the repo layer is the wiring
// between them. The reader and the export share one filter contract, so a
// download that quietly widened or narrowed the filter would be worse than no
// download at all — the operator would draw conclusions from a file that does
// not match what they were looking at. And the cursor is only useful if the
// token this route emits is the token it accepts back.

import { auditStreamKey, repo } from '@app/db';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HAS_INFRA, setupApp, type ApiFixture } from '../_helpers.js';

const describeIfInfra = HAS_INFRA ? describe : describe.skip;

/** Bounds of `auditStreamMaxlen`, matching the contract and the DB check constraint. */
const MIN_MAXLEN = 1_000;
const DEFAULT_MAXLEN = 100_000;

describeIfInfra('profile log surfaces', () => {
  let fx: ApiFixture;
  let redis: Redis;
  let base: string;

  beforeAll(async () => {
    fx = await setupApp();
    redis = new Redis(fx.redisUrl);
    base = `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}`;
    // action_logs is a hypertable and is not in the shared truncate list, so
    // rows outlive a reset. Clear both profiles so counts are deterministic.
    await fx.di.pool.query(`delete from action_logs where profile_id = any($1)`, [
      [fx.alice.profileId, fx.bob.profileId],
    ]);
  });

  afterAll(async () => {
    await redis.quit();
    await fx.cleanup();
  });

  /** Seed one row. `agoSeconds` orders rows on `time` without depending on insert order. */
  const seed = async (
    profileId: string,
    row: {
      level: string;
      msg: string;
      agoSeconds: number;
      symbol?: string | null;
      source?: string;
    },
  ): Promise<void> => {
    await fx.di.pool.query(
      `insert into action_logs (time, profile_id, symbol, level, msg, ctx)
       values (now() - ($5 || ' seconds')::interval, $1, $2, $3, $4,
               jsonb_build_object('source', $6::text))`,
      [
        profileId,
        row.symbol === undefined ? 'BTCUSDT' : row.symbol,
        row.level,
        row.msg,
        String(row.agoSeconds),
        row.source ?? 'tick',
      ],
    );
  };

  const get = (path: string, userId?: string): Promise<Response> =>
    fx.app.request(path, { headers: { 'x-test-user-id': userId ?? fx.alice.userId } });

  describe('GET /logs', () => {
    beforeAll(async () => {
      await fx.di.pool.query(`delete from action_logs where profile_id = any($1)`, [
        [fx.alice.profileId, fx.bob.profileId],
      ]);
      await seed(fx.alice.profileId, { level: 'info', msg: 'entry evaluated', agoSeconds: 40 });
      await seed(fx.alice.profileId, {
        level: 'warn',
        msg: 'entry blocked: cooldown',
        agoSeconds: 30,
        source: 'entry-blocker',
      });
      await seed(fx.alice.profileId, {
        level: 'error',
        msg: 'order rejected -2010',
        agoSeconds: 20,
        symbol: 'ETHUSDT',
      });
      await seed(fx.alice.profileId, { level: 'debug', msg: 'tick captured', agoSeconds: 10 });
      await seed(fx.bob.profileId, { level: 'error', msg: 'bob order rejected', agoSeconds: 15 });
    });

    it('returns this profile’s rows newest-first and no one else’s', async () => {
      const res = await get(`${base}/logs`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: { msg: string }[]; nextCursor: string | null };
      expect(body.items.map((i) => i.msg)).toEqual([
        'tick captured',
        'order rejected -2010',
        'entry blocked: cooldown',
        'entry evaluated',
      ]);
      expect(body.nextCursor).toBeNull();
    });

    it('pages with the cursor it just handed out, without repeating a row', async () => {
      const first = (await (await get(`${base}/logs?limit=2`)).json()) as {
        items: { msg: string }[];
        nextCursor: string | null;
      };
      expect(first.items).toHaveLength(2);
      // A full page cannot prove it was the last, so a cursor must be offered.
      expect(first.nextCursor).not.toBeNull();

      const second = (await (
        await get(`${base}/logs?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? '')}`)
      ).json()) as { items: { msg: string }[]; nextCursor: string | null };
      expect(second.items.map((i) => i.msg)).toEqual([
        'entry blocked: cooldown',
        'entry evaluated',
      ]);
      const overlap = second.items.filter((i) => first.items.some((f) => f.msg === i.msg));
      expect(overlap).toEqual([]);
    });

    it('reports end-of-results by a null cursor on a short page', async () => {
      const body = (await (await get(`${base}/logs?limit=50`)).json()) as {
        nextCursor: string | null;
      };
      expect(body.nextCursor).toBeNull();
    });

    it.each([
      ['levels=error,warn', ['order rejected -2010', 'entry blocked: cooldown']],
      ['symbols=ETHUSDT', ['order rejected -2010']],
      ['source=entry-blocker', ['entry blocked: cooldown']],
      ['q=rejected', ['order rejected -2010']],
      ['levels=debug', ['tick captured']],
    ])('narrows by %s', async (query, expected) => {
      const body = (await (await get(`${base}/logs?${query}`)).json()) as {
        items: { msg: string }[];
      };
      expect(body.items.map((i) => i.msg)).toEqual(expected);
    });

    it('rejects a malformed cursor rather than paging from the head', async () => {
      // Silently restarting at the newest row would make an export loop forever.
      const res = await get(`${base}/logs?cursor=not-a-cursor`);
      expect(res.status).toBe(422);
    });

    it('404s a profile belonging to another operator', async () => {
      const res = await get(
        `/api/accounts/${fx.alice.accountId}/profiles/${fx.bob.profileId}/logs`,
      );
      expect(res.status).toBe(404);
    });

    it('401s without a user', async () => {
      const res = await fx.app.request(`${base}/logs`);
      expect(res.status).toBe(401);
    });
  });

  describe('GET /logs/symbols', () => {
    it('lists the distinct symbols present, for the filter control', async () => {
      const res = await get(`${base}/logs/symbols`);
      expect(res.status).toBe(200);
      expect((await res.json()) as { symbols: string[] }).toEqual({
        symbols: ['BTCUSDT', 'ETHUSDT'],
      });
    });
  });

  describe('GET /logs/export', () => {
    it('streams one JSON object per line under the same filter as the reader', async () => {
      const res = await get(`${base}/logs/export?levels=error,warn`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/x-ndjson');

      const lines = (await res.text()).trim().split('\n');
      const rows = lines.map((l) => JSON.parse(l) as { msg: string; ctx: unknown; id: string });
      expect(rows.map((r) => r.msg)).toEqual(['order rejected -2010', 'entry blocked: cooldown']);

      // Same filter, same rows as the screen: an export that widened the filter
      // would be indistinguishable from a bug in the reader.
      const onScreen = (await (await get(`${base}/logs?levels=error,warn`)).json()) as {
        items: { id: string }[];
      };
      expect(rows.map((r) => r.id)).toEqual(onScreen.items.map((i) => i.id));
    });

    it('carries the full row context, not a summary', async () => {
      const [row] = (await (await get(`${base}/logs/export?q=cooldown`)).text())
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { ctx: { source: string }; time: string; level: string });
      expect(row?.ctx.source).toBe('entry-blocker');
      expect(row?.level).toBe('warn');
      expect(row?.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('names the file after the profile with header-unsafe characters stripped', async () => {
      const res = await get(`${base}/logs/export`);
      const disposition = res.headers.get('content-disposition') ?? '';
      expect(disposition).toMatch(/^attachment; filename="logs-[A-Za-z0-9._-]*\.ndjson"$/);
    });

    it('404s a profile belonging to another operator', async () => {
      const res = await get(
        `/api/accounts/${fx.alice.accountId}/profiles/${fx.bob.profileId}/logs/export`,
      );
      expect(res.status).toBe(404);
    });
  });

  describe('GET /tick-trace', () => {
    const streamEntry = (over: Record<string, unknown> = {}): string =>
      JSON.stringify({
        ts: Date.parse('2026-08-01T00:00:00Z'),
        symbol: 'BTCUSDT',
        event: 'tick',
        decisionTypes: ['noop'],
        latencyMs: 12,
        payload: { reason: 'no signal' },
        ...over,
      });

    beforeAll(async () => {
      const key = auditStreamKey(fx.alice.accountId, fx.alice.profileId);
      await redis.del(key);
      await redis.xadd(key, '1-1', 'body', streamEntry({ symbol: 'BTCUSDT' }));
      await redis.xadd(key, '2-1', 'body', streamEntry({ symbol: 'ETHUSDT', event: 'order' }));
      await redis.xadd(key, '3-1', 'body', streamEntry({ symbol: 'BTCUSDT' }));
      // An entry the drainer left without a parseable body. It must not 500 the
      // window: this reader exists to show what IS there during an incident.
      await redis.xadd(key, '4-1', 'body', '{ not json');
    });

    it('returns the raw stream newest-first with the decoded payload intact', async () => {
      const res = await get(`${base}/tick-trace?limit=10`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: { streamId: string; symbol: string; payload: unknown }[];
        oldestStreamId: string | null;
        truncated: boolean;
      };
      // '4-1' is absent: an entry with an unparseable body is dropped rather
      // than 500ing the window.
      expect(body.items.map((i) => i.streamId)).toEqual(['3-1', '2-1', '1-1']);
      expect(body.items[0]?.payload).toEqual({ reason: 'no signal' });
      expect(body.oldestStreamId).toBe('1-1');
      // Four entries against the default 100000 cap: nothing has been trimmed,
      // so nothing is missing behind them. The stream is simply young.
      expect(body.truncated).toBe(false);
    });

    it('filters by symbol after the read, since the stream interleaves symbols', async () => {
      const body = (await (await get(`${base}/tick-trace?limit=10&symbol=ETHUSDT`)).json()) as {
        items: { streamId: string }[];
      };
      expect(body.items.map((i) => i.streamId)).toEqual(['2-1']);
    });

    it('pages exclusively, so the entry it resumed from is not repeated', async () => {
      const body = (await (await get(`${base}/tick-trace?limit=10&before=3-1`)).json()) as {
        items: { streamId: string }[];
      };
      expect(body.items.map((i) => i.streamId)).toEqual(['2-1', '1-1']);
    });

    it('flags a stream at its cap, and does not read a short page as loss', async () => {
      // The flag answers "is history missing", and only the stream sitting at
      // its configured cap answers that. Page length cannot: a stream shorter
      // than the page is the normal young-stream case, and reporting loss there
      // tells the operator the record is gone when the bot was simply idle —
      // the exact confusion this field exists to prevent, inverted.
      const shortPage = (await (await get(`${base}/tick-trace?limit=50`)).json()) as {
        truncated: boolean;
      };
      expect(shortPage.truncated).toBe(false);

      // Fill a stream to the smallest cap the contract allows. Seeded on bob's
      // profile and deleted afterwards so this cannot perturb the entry ids the
      // other cases in this block assert on, whatever order they run in.
      const bobKey = auditStreamKey(fx.bob.accountId, fx.bob.profileId);
      const pipeline = redis.pipeline();
      for (let i = 1; i <= MIN_MAXLEN; i += 1)
        pipeline.xadd(bobKey, `${i}-1`, 'body', streamEntry());
      await pipeline.exec();
      await repo.retentionConfig.update(fx.di.db, { auditStreamMaxlen: MIN_MAXLEN });
      try {
        const atCap = (await (
          await get(
            `/api/accounts/${fx.bob.accountId}/profiles/${fx.bob.profileId}/tick-trace?limit=50`,
            fx.bob.userId,
          )
        ).json()) as { truncated: boolean };
        expect(atCap.truncated).toBe(true);
      } finally {
        await repo.retentionConfig.update(fx.di.db, { auditStreamMaxlen: DEFAULT_MAXLEN });
        await redis.del(bobKey);
      }
    });

    it('counts raw entries for the flag even when a dropped one shortens the page', async () => {
      // limit=2 reads '4-1' and '3-1'; '4-1' has no parseable body and is
      // dropped. Deriving `truncated` from the surviving items instead of the
      // raw read would call this a short read and tell the operator the stream
      // ends here, when the very next page still returns two entries.
      const body = (await (await get(`${base}/tick-trace?limit=2`)).json()) as {
        items: { streamId: string }[];
        oldestStreamId: string | null;
        truncated: boolean;
      };
      expect(body.items.map((i) => i.streamId)).toEqual(['3-1']);
      expect(body.truncated).toBe(false);
      // Paging resumes from the raw entry, so the dropped one is stepped over
      // rather than re-read forever.
      expect(body.oldestStreamId).toBe('3-1');
    });

    it('survives an entry whose ts is a number no Date can represent', async () => {
      // `new Date(1e20).toISOString()` throws RangeError, and the decode runs
      // outside the JSON try/catch — so one such entry would 500 the whole
      // window, taking the readable entries around it with it, at exactly the
      // moment the operator is reading this view to find out what happened.
      const key = auditStreamKey(fx.alice.accountId, fx.alice.profileId);
      await redis.xadd(key, '5-1', 'body', streamEntry({ ts: 1e20 }));
      try {
        const res = await get(`${base}/tick-trace?limit=10`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: { streamId: string; ts: string }[] };
        expect(body.items.map((i) => i.streamId)).toEqual(['5-1', '3-1', '2-1', '1-1']);
        // Epoch, the same fallback a missing `ts` gets — visibly wrong rather
        // than plausible, so nobody reads it as a real timestamp.
        expect(body.items[0]?.ts).toBe('1970-01-01T00:00:00.000Z');
      } finally {
        await redis.xdel(key, '5-1');
      }
    });

    it('reads an empty stream as empty rather than erroring', async () => {
      const res = await get(
        `/api/accounts/${fx.bob.accountId}/profiles/${fx.bob.profileId}/tick-trace`,
        fx.bob.userId,
      );
      expect(res.status).toBe(200);
      expect((await res.json()) as { items: unknown[] }).toMatchObject({ items: [] });
    });

    it('404s a profile belonging to another operator', async () => {
      const res = await get(
        `/api/accounts/${fx.alice.accountId}/profiles/${fx.bob.profileId}/tick-trace`,
      );
      expect(res.status).toBe(404);
    });
  });
});
