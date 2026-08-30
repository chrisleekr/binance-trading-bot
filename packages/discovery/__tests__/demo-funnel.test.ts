// The seeded demo funnel is what the docs discovery screenshot is captured from, so it has to survive the same projection the live panel draws rather than merely being well-formed. The stage set itself is the compiler's job now: `demoScanFunnel` returns a `DiscoveryFunnel`, so a renamed or dropped rung fails typecheck. What a type cannot say is that the numbers still tell the story the user guide tells, which is everything below.

import {
  largestDrop,
  projectDiagnosisFunnel,
  worstChoke,
  type DiagnosisFunnelView,
} from '@app/contracts';
import { describe, expect, it } from 'vitest';

import { demoScanFunnel } from '../src/demo-funnel.js';

const scan = (probed: number, age: number, trend: number, eligible: number, added: number) =>
  demoScanFunnel({ probed, age, trend, eligible, added, kept: 3 });

const viewOf = (funnels: readonly ReturnType<typeof scan>[]): DiagnosisFunnelView | null =>
  projectDiagnosisFunnel({
    nowMs: 1_700_000_000_000,
    snapshots: funnels.map((funnel, i) => ({
      capturedAtMs: 1_700_000_000_000 - i * 900_000,
      breadthOk: funnel.breadthOk,
      funnel: funnel as never,
    })),
  });

describe('demoScanFunnel', () => {
  it('fills both ladders the panel draws, with no rung dropped', () => {
    // `ladder` flat-maps out any stage whose value is not a number, so a rung the projection cannot read does not surface as undefined — it silently shortens the ladder. The rung COUNT is therefore what catches a drift between this payload and the contract.
    const view = viewOf([scan(11, 10, 6, 4, 0), scan(10, 9, 5, 3, 1)]);
    expect(view).not.toBeNull();
    expect(view?.ticker).toHaveLength(8);
    expect(view?.candidate).toHaveLength(4);
    expect(view?.history).toHaveLength(2);
  });

  it('keeps each ladder monotonic and the candidate segment below the ticker segment', () => {
    const view = viewOf([scan(11, 10, 6, 4, 0)]);
    const survivors = (rungs: readonly { survivors: number }[]) => rungs.map((r) => r.survivors);
    const ticker = survivors(view?.ticker ?? []);
    const candidate = survivors(view?.candidate ?? []);
    expect(ticker).toEqual([...ticker].sort((a, b) => b - a));
    expect(candidate).toEqual([...candidate].sort((a, b) => b - a));
    // The user guide tells the operator the second ladder's top row is legitimately far below the first ladder's bottom row, because it counts only the shortlist klines were fetched for. A seeded funnel that inverted that would make the docs contradict their own screenshot.
    expect(candidate[0]).toBeLessThan(ticker[ticker.length - 1] as number);
  });

  it('puts the choke on a stage the operator can tune', () => {
    // The panel names the worst proportional drop as the choke and tells the reader that is the setting to look at first. Landing it on the quote or asset-policy rows would point them at something they cannot change.
    const view = viewOf([scan(11, 10, 6, 4, 0)]);
    const rungs = (r: readonly { stage: string; survivors: number }[]) =>
      r.map((s) => [s.stage, s.survivors] as const);
    const choke = worstChoke(
      largestDrop(rungs(view?.ticker ?? [])),
      largestDrop(rungs(view?.candidate ?? [])),
    );
    expect(choke?.stage).toBe('changeBand');
  });
});
