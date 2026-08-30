// The discovery cron's rotatable/pinned split, tested at the predicate the cron actually calls.
//
// Every row here carries a `source` that would send it to the WRONG list under the pre-split, provenance-keyed filter, so a revert to `source === 'auto'` cannot pass: the recovered and released rows would vanish from `rotatable`, and the pinned discovery find would appear in it.

import { describe, expect, it } from 'vitest';

import { partitionByPin } from '../../../src/crons/discovery/pin-partition.js';

// One row per combination that the two columns can produce and that the reap has to tell apart.
const rows = [
  // Rotated in by discovery and still unprotected: the ordinary auto member.
  { symbol: 'AUTOUSDT', source: 'auto', pinned: false },
  // Re-created by the bot to recover a position nobody was tracking. Nobody chose this coin, so it must rotate — and under a provenance-keyed filter it was in neither list, holding a slot forever.
  { symbol: 'RECUSDT', source: 'unknown', pinned: false },
  // Operator provenance with the pin RELEASED: they added it, then handed it back to discovery. Provenance alone must not keep it.
  { symbol: 'MANUSDT', source: 'manual', pinned: false },
  // The only protected row.
  { symbol: 'PINUSDT', source: 'manual', pinned: true },
  // Pinned despite discovery having found it: pinning does not rewrite provenance, and the split must still honour the pin.
  { symbol: 'PINAUTOUSDT', source: 'auto', pinned: true },
];

describe('partitionByPin', () => {
  it('routes every UNPINNED binding to rotatable, whatever created it', () => {
    expect(partitionByPin(rows).rotatable).toEqual(['AUTOUSDT', 'RECUSDT', 'MANUSDT']);
  });

  it('routes every PINNED binding to pinned, whatever created it', () => {
    expect(partitionByPin(rows).pinned).toEqual(['PINUSDT', 'PINAUTOUSDT']);
  });

  it('partitions totally: every row lands in exactly one list', () => {
    // A row that reached neither list is the failure mode that hides a coin from both the slot cap and the reap, so the counts are asserted rather than left implicit.
    const { rotatable, pinned } = partitionByPin(rows);
    expect([...rotatable, ...pinned].sort()).toEqual(rows.map((r) => r.symbol).sort());
  });

  it('returns two empty lists for a profile with no bindings', () => {
    expect(partitionByPin([])).toEqual({ rotatable: [], pinned: [] });
  });
});
