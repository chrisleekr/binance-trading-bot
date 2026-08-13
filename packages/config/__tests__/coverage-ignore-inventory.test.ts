import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { discoverWorkspaceRoots } from '../../../scripts/ci/workspaces.ts';
import {
  scanV8IgnoreSource,
  type V8IgnoreDirective,
  v8IgnoreIdentityDigest,
} from './helpers/v8-ignore.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const drainGuard = [
  'start|the while guard proves waiters is non-empty, so shift() always returns a value; the falsy-w arm is a noUncheckedIndexedAccess guard only',
  'stop|end of the unreachable noUncheckedIndexedAccess drain guard above',
] as const;

// This reviewed inventory makes every exclusion change an explicit policy decision.
const REVIEWED_IGNORES: Record<string, readonly string[]> = {
  'packages/binance/src/binance-rest.ts': [
    'next|signed calls always set recvWindow+timestamp in `merged`, so `qs` is never empty here; this empty-qs arm is unreachable',
  ],
  'packages/binance/src/market-data/fake-port.ts': [
    ...drainGuard,
    ...drainGuard,
    'start|unsubscribe() and return() delete a sub from the set in the same step they set cancelled, so a cancelled sub is never iterated here',
    'stop|end of the unreachable cancelled-sub guard above',
    ...drainGuard,
    'start|cancel() deletes a ticker sub from the set in the same step it sets cancelled, so a cancelled sub is never iterated here',
    'stop|end of the unreachable cancelled-ticker-sub guard above',
    ...drainGuard,
    ...drainGuard,
  ],
  'packages/binance/src/market-data/kline-fetcher.ts': [
    'start|every sendRpc call passes a single-element [stream] array, so the empty-streams guard is never true',
    'stop|end of the unreachable empty-streams guard above',
    'start|flushPendingRpcs runs only inside onOpen, which sets ws and isOpen first, so this not-ready guard is never true',
    'stop|end of the unreachable not-ready guard above',
    'start|assignStream caps each member at BINANCE_MAX_STREAMS_PER_CONNECTION before recording a stream, so connect/assignStream never pass a count over the cap; this is an unreachable defense-in-depth guard',
    'stop|end of the unreachable per-connection cap guard above',
    'start|cancelSubscriber deletes a sub from the set in the same step it sets cancelled, so a cancelled sub is never iterated here',
    'stop|end of the unreachable cancelled-sub guard above',
    'start|cancel() deletes a ticker sub from the set in the same step it sets cancelled, so a cancelled sub is never iterated here',
    'stop|end of the unreachable cancelled-ticker-sub guard above',
    'start|coldLoad runs once per key (only when isNewKey), so the in-flight reentrancy guard is never true',
    'stop|end of the unreachable coldLoad reentrancy guard above',
    'start|connect runs on first subscribe (stopped is false) or via a reconnect schedule that onClose only arms when !stopped, so the stopped guard is never true here; and connect always runs with at least one active stream on the member (the subscribe that triggered it, or onClose only reconnecting when the member still holds streams)',
    'stop|end of the unreachable stopped / empty-streams guards above',
    "start|a key/ticker always records the id of a live member once assigned, so the lookup never misses; defense-in-depth against both a noUncheckedIndexedAccess miss and the memberId === -1 sentinel window (a key's memberId is -1 until the isNewKey path assigns it, so a release before assignment would also land here)",
    'stop|end of the unreachable missing-member guard above',
    'start|m came from members.find, so it is always present; the index guard is defense-in-depth',
    'stop|end of the unreachable index guard above',
    ...drainGuard,
    ...drainGuard,
    ...drainGuard,
    ...drainGuard,
  ],
  'packages/binance/src/public-klines.ts': [
    'start|every loop iteration returns or throws; this post-loop throw exists only to satisfy the type checker.',
    'stop|',
  ],
  'packages/binance/src/rate-limit/order-governor.ts': [
    'start|blockingWindow only returns a window whose in-window total exceeds the ceiling, which requires at least one record; the guard exists for noUncheckedIndexedAccess narrowing',
    'stop|end of the unreachable empty-ring guard above',
    'start|the Promise executor runs synchronously and assigns rejectAbort before this finally, so it is always defined here',
    'stop|end of the unreachable rejectAbort-undefined guard above',
  ],
  'packages/binance/src/rate-limit/redis-weight-governor.ts': [
    'start|the Promise executor runs synchronously and assigns onAbort before this finally, so it is always defined here',
    'stop|end of the unreachable onAbort-undefined guard above',
    'start|the Promise executor runs synchronously and assigns timer before this finally, so it is always defined here',
    'stop|end of the unreachable timer-undefined guard above',
  ],
  'packages/binance/src/rate-limit/weight-governor.ts': [
    'start|reaching here requires used > 0, which means the ring is non-empty, so records[0] is always defined; guard exists only for noUncheckedIndexedAccess narrowing',
    'stop|end of the unreachable empty-ring guard above',
    'start|the Promise executor runs synchronously and assigns rejectAbort before this finally, so it is always defined here',
    'stop|end of the unreachable rejectAbort-undefined guard above',
  ],
  'packages/indicators/src/incremental/stochastic.ts': [
    'start|the seed walks exactly minWindow = period+smoothK-1 candles, so kRing receives exactly smoothK pushes and never exceeds it; this trim is a guard that never fires during seeding',
    'stop|end of the unreachable seed kRing-trim guard above',
  ],
  'packages/indicators/src/index.ts': [
    'start|rsi/atr only call at() with indices proven in range by their requirePeriod guard, so this out-of-bounds throw is a noUncheckedIndexedAccess guard that never fires',
    'stop|end of the unreachable out-of-bounds guard above',
  ],
  'packages/indicators/src/rating/adapter.ts': [
    'start|both arms are defensive for the union type and unreachable in practice — every adapter wrapper guards its window length before calling (so getResult() is non-null), and vendored results are always plain numbers, never Decimal',
    'stop|',
    'start|DX sets pdi/mdi once its smoothing is stable, which always holds for w.length >= period+1 (the guard above), so this null check never returns',
    'stop|end of the unreachable DX null-DI guard above',
    'start|MACD emits a result once it has longInterval+signalInterval closes, which the length guard above guarantees, so r is never null here',
    'stop|end of the unreachable null-MACD-result arm above',
  ],
  'packages/indicators/src/rating/bb-power.ts': [
    'start|w.length >= period >= 1 here, so w[w.length-1] is always defined; this is a noUncheckedIndexedAccess guard',
    'stop|end of the unreachable last-undefined guard above',
    'start|ema(w, period) returns null only when w.length < period, which the guard above already excluded, so emaClose is never null here',
    'stop|end of the unreachable null-ema guard above',
  ],
  'packages/indicators/src/rating/hull-ma.ts': [
    'start|period >= 2 here (period <= 1 returned null above), so floor(sqrt(period)) >= 1; the sqrtFloor < 1 fallback to 1 is unreachable',
    'stop|end of the unreachable sqrtFloor<1 fallback above',
    'start|each slice is exactly as long as its period, so both wma() calls always return a value; the null-skip is a guard that never fires',
    'stop|end of the unreachable wma-null skip above',
    'start|firstPrefix >= period >= 2 and i <= w.length, so w[i-1] is always defined; noUncheckedIndexedAccess guard',
    'stop|end of the unreachable last-undefined guard above',
  ],
  'packages/indicators/src/rating/rating.ts': [
    'start|mean is only ever called with the fixed 10-osc and 15-ma vote arrays, which are never empty, so the length-0 guard is unreachable',
    'stop|end of the unreachable empty-votes guard above',
  ],
  'packages/indicators/src/rating/ultimate-osc.ts': [
    'start|callers pass period <= endExclusive <= arr.length, so every index is in range; the ?? ZERO fallback is a noUncheckedIndexedAccess guard that never fires',
    'stop|end of the unreachable ?? ZERO index guard above',
    'start|i ranges over [1, w.length), so w[i] and w[i-1] are always defined; noUncheckedIndexedAccess guard',
    'stop|end of the unreachable candle-undefined guard above',
    'start|the loop never `continue`s (the candle guard above is unreachable), so bp gets win.length-1 entries; win is exactly long+1 bars (or w, which is >= long+1), so bp.length >= long always, making this guard unreachable',
    'stop|end of the unreachable short-bp guard above',
  ],
  'packages/indicators/src/rating/vendored/types/Indicator.ts': [
    'start|rollbackLastResult is an upstream helper for sparse swing-point indicators; none of the vendored classes used in this tree call it, so it is dead at runtime here',
    'stop|end of the unused rollbackLastResult helper above',
  ],
  'packages/strategy/core/src/replay.ts': [
    "next|root call always passes a named path, so path is never ''",
  ],
  'packages/strategy/rebalance/src/momentum.ts': [
    'start|length > lookbackCandles guarantees both indices are in range; the guard only satisfies noUncheckedIndexedAccess',
    'stop|',
  ],
  'packages/strategy/trailing-trade/src/branches/first-entry.ts': [
    'next|regime filter gates only promotions (avgEntryPrice set); a forced re-entry is always a flat level-0 entry, so skip-regime never reaches this arm',
  ],
  'packages/strategy/trailing-trade/src/branches/grid-buy.ts': [
    'next|a non-null trigger proves lvl0 is defined (the grid path enforces gridLevels.length > 0), so the raw multiplier string is always read; the parsed fallback is an unreachable noUncheckedIndexedAccess guard',
    'start|the enclosing branch proves currentGridTradeIndex + 1 < levels.length, so this index is always defined (noUncheckedIndexedAccess guard)',
    'stop|end of the unreachable noUncheckedIndexedAccess guard above',
    'start|evaluateRegimeFilter always sets reason+context on a not-ok result; these ?? fallbacks guard a hypothetical future result shape',
    'stop|end of the unreachable reason/context fallback above',
  ],
  'packages/strategy/trailing-trade/src/decisions.ts': [
    "next|LIMIT decisions are only built after computeManualOrderQuantity accepts a non-empty price, so the '0' fallback is unreachable",
  ],
  'packages/strategy/trailing-trade/src/schema.ts': [
    'start|i < levels.length so the indexed access is always defined; the undefined guard exists only for noUncheckedIndexedAccess',
    'stop|end of the unreachable noUncheckedIndexedAccess guard above',
  ],
  'packages/strategy/trailing-trade/src/tick.ts': [
    'start|every caller is a sell-emit site that already holds a position (avgEntryPrice non-null) and re-uses prices the sell gate parsed successfully, so the null and parse-fail guards are unreachable by construction; they are belt-and-braces against a future caller',
    'stop|end of the unreachable defensive guards above',
    'start|sellEmissionOrSkip returns only emit|skip and the emit case returned above, so emission is always skip here; the implicit else is unreachable',
    'stop|end of the unreachable emit|skip else arm above',
    'start|sellEmissionOrSkip returns only emit|skip and emit returned above, so emission is always skip here; the else arm is unreachable by construction',
    'stop|end of the unreachable emit|skip else arm above',
    'start|the final branch (buyAndSnapshotBranch) always returns a terminal outcome, so the loop never falls through; this throw guards a future branch-list edit',
    'stop|end of the unreachable loop-terminator guard above',
  ],
};

const REVIEWED_IDENTITY_DIGESTS: Record<string, string> = {
  'packages/binance/src/binance-rest.ts': 'ca4e3e24af94ffc0',
  'packages/binance/src/market-data/fake-port.ts': '64e259fdba0be49f',
  'packages/binance/src/market-data/kline-fetcher.ts': '8bc0a3461d279b30',
  'packages/binance/src/public-klines.ts': '009866645bd7ee6e',
  'packages/binance/src/rate-limit/order-governor.ts': '69a2af6b660773d2',
  'packages/binance/src/rate-limit/redis-weight-governor.ts': '80050d886ff3f55c',
  'packages/binance/src/rate-limit/weight-governor.ts': '4e4c7987ba8df2db',
  'packages/indicators/src/rating/hull-ma.ts': 'e1ca5bb677b11575',
  'packages/indicators/src/rating/ultimate-osc.ts': 'c95f2aa4f5d8a0b0',
  'packages/indicators/src/rating/adapter.ts': '37c984f905aaf5d8',
  'packages/indicators/src/rating/rating.ts': '27f82c1ae21afe02',
  'packages/indicators/src/rating/vendored/types/Indicator.ts': 'be4fb9e729d0806e',
  'packages/indicators/src/rating/bb-power.ts': '868b07b34d0682fe',
  'packages/indicators/src/incremental/stochastic.ts': 'c2bff13345ee5b38',
  'packages/indicators/src/index.ts': '8fb4495c172df93a',
  'packages/strategy/core/src/replay.ts': '0bce841953ec4aed',
  'packages/strategy/rebalance/src/momentum.ts': '6061dccad62477d7',
  'packages/strategy/trailing-trade/src/schema.ts': '9463593c0ee84865',
  'packages/strategy/trailing-trade/src/tick.ts': '3b4fb3c021741c38',
  'packages/strategy/trailing-trade/src/decisions.ts': '808cb59efc8eb679',
  'packages/strategy/trailing-trade/src/branches/grid-buy.ts': '2d1b05abe70d76b9',
  'packages/strategy/trailing-trade/src/branches/first-entry.ts': '7f054f05a0b4b551',
};

const sourceFiles = (root: string): string[] =>
  readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:[cm]?js|[cm]?ts|jsx|tsx)$/.test(entry.name) ? [path] : [];
  });

const scanIgnores = (): Record<string, V8IgnoreDirective[]> => {
  const inventory: Record<string, V8IgnoreDirective[]> = {};
  for (const workspace of discoverWorkspaceRoots(REPO_ROOT)) {
    const src = join(workspace, 'src');
    if (!readdirSync(workspace).includes('src')) continue;
    for (const path of sourceFiles(src)) {
      const repoPath = relative(REPO_ROOT, path).replaceAll('\\', '/');
      const directives = scanV8IgnoreSource(readFileSync(path, 'utf8'));
      if (directives.length > 0) inventory[repoPath] = directives;
    }
  }
  return inventory;
};

describe('reviewed v8 ignore inventory', () => {
  it('rejects an added, removed, moved, or reworded coverage exclusion', () => {
    const inventory = scanIgnores();
    expect(
      Object.fromEntries(
        Object.entries(inventory).map(([path, directives]) => [
          path,
          directives.map(({ kind, reason }) => `${kind}|${reason}`),
        ]),
      ),
    ).toEqual(REVIEWED_IGNORES);
    expect(
      Object.fromEntries(
        Object.entries(inventory).map(([path, directives]) => [
          path,
          v8IgnoreIdentityDigest(directives),
        ]),
      ),
    ).toEqual(REVIEWED_IDENTITY_DIGESTS);
  });

  it('captures file and conditional directive forms', () => {
    const directives = scanV8IgnoreSource(`
/* v8 ignore file -- reason: generated */
/* v8 ignore if -- reason: impossible true branch */
if (condition) work();
/* v8 ignore else -- reason: impossible false branch */
else fallback();
`);

    expect(directives.map(({ kind }) => kind)).toEqual(['file', 'if', 'else']);
    expect(
      directives.every(({ affectedSourceFingerprint }) => affectedSourceFingerprint.length === 16),
    ).toBe(true);
  });

  it('changes directive identity when an unchanged directive moves', () => {
    const original = scanV8IgnoreSource('/* v8 ignore next -- reason: generated */\nwork();')[0]!;
    const moved = scanV8IgnoreSource('\n/* v8 ignore next -- reason: generated */\nwork();')[0]!;

    expect(moved.affectedSourceFingerprint).toBe(original.affectedSourceFingerprint);
    expect(moved.location).not.toBe(original.location);
  });

  it('changes identity when an inline or multiline ignored construct changes', () => {
    const inline = scanV8IgnoreSource(
      '/* v8 ignore next -- reason: generated */ const value = 1;',
    )[0]!;
    const changedInline = scanV8IgnoreSource(
      '/* v8 ignore next -- reason: generated */ const value = 2;',
    )[0]!;
    const multiline = scanV8IgnoreSource(
      '/* v8 ignore if -- reason: impossible */\nif (condition) {\n  work();\n}',
    )[0]!;
    const changedMultiline = scanV8IgnoreSource(
      '/* v8 ignore if -- reason: impossible */\nif (condition) {\n  otherWork();\n}',
    )[0]!;

    expect(changedInline.affectedSourceFingerprint).not.toBe(inline.affectedSourceFingerprint);
    expect(changedMultiline.affectedSourceFingerprint).not.toBe(
      multiline.affectedSourceFingerprint,
    );
  });
});
