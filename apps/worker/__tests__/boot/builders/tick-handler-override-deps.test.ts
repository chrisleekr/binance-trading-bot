// The override-row deps the boot builder must actually wire.
//
// `claimOverrideAction` and `releaseOverrideClaim` are optional on
// `TickHandlerDeps`, and they have to be: a unit harness that never exercises the
// override path should not have to stub them, and unwired the tick behaves exactly
// as it did before. That tolerance is also the failure mode. Left out of the boot
// builder by accident, the tick treats every override as claimed, the cancel route's
// `processing_at is null` delete guard never engages again, and the operator can be
// told an action was cancelled while its order reaches Binance — with every unit test
// still green, because they all pass their own stubs.
//
// So the wiring is asserted here, at the one call site that runs in production, and
// asserted through the REAL repo functions: `claimAction` is a CAS whose reply the
// dispatch gate acts on, so "a function is present" is not enough — it has to be THAT
// function, and it has to return the CAS verdict rather than swallow it.

import { describe, expect, it, vi } from 'vitest';
import { asAccountId, asProfileId, asUserId } from '@app/contracts';
import type { ProfileScope } from '@app/db';

import type { BootEnv } from '../../../src/boot/boot-env.js';
import type { TickHandlerDeps } from '../../../src/tick/tick-types.js';
import { buildChain } from '../../../src/boot/builders/chain.js';
import { anyProxy, fakeDb, fakeQueueSet, fakeRedis, silentLogger } from './fakes.js';

/**
 * The builder hands its assembled deps to `createTickHandler` and returns only the
 * handler, so the deps object is reachable nowhere else. Mocked by the path the test
 * file resolves (a tsconfig alias is not a module id vitest can match).
 */
const captured: { deps?: TickHandlerDeps } = {};
vi.mock('../../../src/tick/tick-handler.js', () => ({
  createTickHandler: (deps: TickHandlerDeps) => {
    captured.deps = deps;
    return async () => undefined;
  },
}));

const { buildTickHandler } = await import('../../../src/boot/builders/tick-handler.js');

const ENV: BootEnv = { redisUrl: 'redis://localhost:1', pgUrl: 'postgres://localhost:1/x' };
const OVERRIDE_ACTION_ID = '01234567-89ab-4cde-89ab-cdef01234567';
/** The stamp the tick claims with, and the fence its release must be matched on. */
const CLAIM_AT = new Date('2026-07-30T00:00:00.000Z');

/** One recorded UPDATE: the column values written, and the rows the DB answered with. */
interface RecordedUpdate {
  readonly values: Record<string, unknown>;
}

/**
 * Minimal drizzle-shaped update chain. `where()` is both awaitable and carries
 * `.returning()`, because the two repo functions under test end their chains
 * differently: the claim reads its rows back, the release does not.
 */
const spyScope = (
  updates: RecordedUpdate[],
  rows: readonly { id: string }[],
): { scope: ProfileScope } => {
  const db = {
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push({ values });
        return {
          where: () => {
            const settled = Promise.resolve(rows) as Promise<readonly { id: string }[]> & {
              returning?: () => Promise<readonly { id: string }[]>;
            };
            settled.returning = () => Promise.resolve(rows);
            return settled;
          },
        };
      },
    }),
  };
  return {
    scope: {
      db,
      operatorId: asUserId('11111111-1111-4111-8111-111111111111'),
      accountId: asAccountId('33333333-3333-4333-8333-333333333333'),
      profileId: asProfileId('22222222-2222-4222-8222-222222222222'),
    } as unknown as ProfileScope,
  };
};

const buildDeps = (): TickHandlerDeps => {
  buildTickHandler({
    env: ENV,
    db: fakeDb(),
    redis: fakeRedis(),
    logger: silentLogger(),
    chain: buildChain(),
    queueSet: fakeQueueSet(),
    liveExecutor: anyProxy(),
    coldLoad: anyProxy(),
    symbolInfoCache: { get: async () => ({}) } as never,
    statePort: anyProxy(),
    metrics: anyProxy(),
    klineFetcher: anyProxy(),
    notifyEvent: async () => undefined,
    orderFailedThrottle: { allow: async () => true } as never,
    auditShipper: anyProxy(),
  });
  const deps = captured.deps;
  if (!deps) throw new Error('buildTickHandler did not construct a tick handler');
  return deps;
};

describe('buildTickHandler — override row claim deps', () => {
  it('wires the claim so the dispatch gate can be enforced in production', () => {
    const deps = buildDeps();

    expect(typeof deps.claimOverrideAction).toBe('function');
    expect(typeof deps.releaseOverrideClaim).toBe('function');
  });

  it('claims through the CAS and returns its verdict', async () => {
    // One row updated means this tick won the row.
    const updates: RecordedUpdate[] = [];
    const { scope } = spyScope(updates, [{ id: OVERRIDE_ACTION_ID }]);
    const deps = buildDeps();

    await expect(deps.claimOverrideAction?.(scope, OVERRIDE_ACTION_ID, CLAIM_AT)).resolves.toBe(
      true,
    );
    expect(updates).toHaveLength(1);
    // Stamping `processing_at` is what makes the row undeletable by the cancel route,
    // and it stamps the CALLER's value: a database-side `now()` would leave the tick
    // unable to name the stamp its release has to be fenced on.
    expect(updates[0]?.values.processingAt).toBe(CLAIM_AT);
  });

  it('reports a lost claim rather than swallowing it', async () => {
    // Zero rows updated: the row was already claimed, already settled, or deleted by
    // the operator's cancel. A wiring that discarded this and answered `true` would
    // re-open the exact race the claim closes.
    const updates: RecordedUpdate[] = [];
    const { scope } = spyScope(updates, []);
    const deps = buildDeps();

    await expect(deps.claimOverrideAction?.(scope, OVERRIDE_ACTION_ID, CLAIM_AT)).resolves.toBe(
      false,
    );
  });

  it('releases by clearing the claim, not by consuming the row', async () => {
    // The release hands the override back for a later tick to retry, so it must only
    // null `processing_at`; writing `consumed_at` here would settle an override that
    // never ran.
    const updates: RecordedUpdate[] = [];
    const { scope } = spyScope(updates, []);
    const deps = buildDeps();

    await expect(
      deps.releaseOverrideClaim?.(scope, OVERRIDE_ACTION_ID, CLAIM_AT),
    ).resolves.toBeUndefined();
    expect(updates).toHaveLength(1);
    expect(updates[0]?.values).toEqual({ processingAt: null });
  });
});
