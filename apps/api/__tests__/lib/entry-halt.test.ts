import { asAccountId, asProfileId, EntryHaltKind } from '@app/contracts';
import { entryHaltKeys } from '@app/db';
import { describe, expect, it } from 'vitest';

import type { DI } from '../../src/di.js';
import { activeEntryHalts } from '../../src/lib/entry-halt.js';

const A = asAccountId('00000000-0000-0000-0000-0000000000a1');
const P = asProfileId('00000000-0000-0000-0000-000000000002');
const SCOPE = { accountId: A, profileId: P };
const HALT_KEYS = entryHaltKeys(SCOPE);

// A Tuesday, so `nextUtcMidnightMs` for the daily flag is unambiguously ahead of NOW.
const NOW = Date.UTC(2026, 8, 1, 12, 0, 0);

/** DI whose `pttl` answers from an explicit per-kind table, so a test can post a -1 no live Redis would hand back on a healthy key. */
const diWithPttl = (byKind: Partial<Record<EntryHaltKind, number>>): DI =>
  ({
    logger: { warn: () => {} },
    redis: {
      raw: () => ({
        pttl: async (key: string) => {
          const kind = EntryHaltKind.options.find((k) => HALT_KEYS[k] === key);
          return kind === undefined ? -2 : (byKind[kind] ?? -2);
        },
      }),
    },
  }) as unknown as DI;

describe('activeEntryHalts', () => {
  it('reports a key with no expiry as an active halt lifting now, not as an absent one', async () => {
    // -1 is "present, no TTL". It must land in the output the way a positive TTL does: dropping it the way a -2 is dropped would tell the operator buying is open while the tick path still refuses every BUY.
    const halts = await activeEntryHalts(diWithPttl({ drawdown: -1 }), SCOPE, NOW);

    expect(halts).toHaveLength(1);
    expect(halts[0]?.kind).toBe('drawdown');
    // Exactly NOW, not merely at-or-after it: `Math.max(0, -1)` is what makes "lifts now" true, and a lower bound would still pass if that clamp grew a floor or the -1 started meaning "never lifts".
    expect(halts[0]?.liftsAtMs).toBe(NOW);
  });

  it('returns the active breakers in EntryHaltKind order regardless of which are armed', async () => {
    const halts = await activeEntryHalts(
      diWithPttl({ drawdown: 60_000, 'daily-loss': 60_000, 'loss-streak': -1 }),
      SCOPE,
      NOW,
    );

    expect(halts.map((h) => h.kind)).toEqual([...EntryHaltKind.options]);
  });

  it('is empty when every flag is absent', async () => {
    await expect(activeEntryHalts(diWithPttl({}), SCOPE, NOW)).resolves.toEqual([]);
  });

  it('THROWS on a Redis fault rather than answering "not halted"', async () => {
    // Paired with the empty case above deliberately: a regression that swallowed the fault and returned [] would be indistinguishable from a healthy un-halted profile, which is exactly the misstatement this function refuses to make.
    const di = {
      logger: { warn: () => {} },
      redis: {
        raw: () => ({
          pttl: async () => {
            throw new Error('redis down');
          },
        }),
      },
    } as unknown as DI;

    await expect(activeEntryHalts(di, SCOPE, NOW)).rejects.toThrow('redis down');
  });
});
