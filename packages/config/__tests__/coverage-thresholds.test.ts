import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { COVERAGE_POLICY, PER_PACKAGE_THRESHOLDS } from '../vitest/index.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const COVERAGE_LANES = ['unit', 'integration', 'worker-integration', 'db-isolation'] as const;
type CoverageLane = (typeof COVERAGE_LANES)[number];
type Thresholds = { readonly lines: number; readonly branches: number };

// These reviewed floors are independent of the runtime policy so lowering the
// policy cannot silently lower its own test expectation.
const APPROVED_FLOORS = {
  '@app/api': { lines: 79, branches: 73 },
  '@app/server': { lines: 17, branches: 12 },
  '@app/web': { lines: 80, branches: 70 },
  '@app/worker': { lines: 88, branches: 82 },
  '@app/binance': { lines: 100, branches: 100, exact: true },
  '@app/contracts': { lines: 97, branches: 89 },
  '@app/core': { lines: 94, branches: 92 },
  '@app/db': { lines: 82, branches: 74 },
  '@app/discovery': { lines: 100, branches: 100, exact: true },
  '@app/indicators': { lines: 100, branches: 100, exact: true },
  '@app/llm': { lines: 80, branches: 82 },
  '@app/money': { lines: 100, branches: 100, exact: true },
  '@app/notify': { lines: 100, branches: 97 },
  '@app/observability': { lines: 82, branches: 56 },
  '@app/strategy-backtest': { lines: 98, branches: 85 },
  '@app/strategy-core': { lines: 100, branches: 100, exact: true },
  '@app/strategy-momentum': { lines: 100, branches: 100, exact: true },
  '@app/strategy-rebalance': { lines: 100, branches: 100, exact: true },
  '@app/strategy-registry': { lines: 100, branches: 100, exact: true },
  '@app/strategy-trailing-trade': { lines: 100, branches: 100, exact: true },
} as const;

const CONFIG_PATHS: Record<keyof typeof APPROVED_FLOORS, string> = {
  '@app/api': 'apps/api/vitest.config.ts',
  '@app/server': 'apps/server/vitest.config.ts',
  '@app/web': 'apps/web/vitest.config.ts',
  '@app/worker': 'apps/worker/vitest.config.ts',
  '@app/binance': 'packages/binance/vitest.config.ts',
  '@app/contracts': 'packages/contracts/vitest.config.ts',
  '@app/core': 'packages/core/vitest.config.ts',
  '@app/db': 'packages/db/vitest.config.ts',
  '@app/discovery': 'packages/discovery/vitest.config.ts',
  '@app/indicators': 'packages/indicators/vitest.config.ts',
  '@app/llm': 'packages/llm/vitest.config.ts',
  '@app/money': 'packages/money/vitest.config.ts',
  '@app/notify': 'packages/notify/vitest.config.ts',
  '@app/observability': 'packages/observability/vitest.config.ts',
  '@app/strategy-backtest': 'packages/strategy/backtest/vitest.config.ts',
  '@app/strategy-core': 'packages/strategy/core/vitest.config.ts',
  '@app/strategy-momentum': 'packages/strategy/momentum/vitest.config.ts',
  '@app/strategy-rebalance': 'packages/strategy/rebalance/vitest.config.ts',
  '@app/strategy-registry': 'packages/strategy/registry/vitest.config.ts',
  '@app/strategy-trailing-trade': 'packages/strategy/trailing-trade/vitest.config.ts',
};

const configModules = Object.fromEntries(
  Object.entries(CONFIG_PATHS).map(([packageName, path]) => [
    packageName,
    pathToFileURL(join(REPO_ROOT, path)).href,
  ]),
);
const snapshots = new Map<CoverageLane | 'absent', Record<string, Thresholds | null>>();

const loadThresholdSnapshot = (
  lane: CoverageLane | undefined,
): Record<string, Thresholds | null> => {
  const key = lane ?? 'absent';
  const cached = snapshots.get(key);
  if (cached) return cached;

  const env = { ...process.env, CONFIG_MODULES: JSON.stringify(configModules) };
  if (lane) env['COVERAGE_LANE'] = lane;
  else delete env['COVERAGE_LANE'];
  const script = `
    const modules = JSON.parse(process.env.CONFIG_MODULES);
    const result = {};
    await Promise.all(Object.entries(modules).map(async ([packageName, url]) => {
      const config = (await import(url)).default;
      result[packageName] = config.test?.coverage?.thresholds ?? null;
    }));
    console.log("CONFIG_THRESHOLDS=" + JSON.stringify(result));
  `;
  const loaded = spawnSync('bun', ['-e', script], { cwd: REPO_ROOT, env, encoding: 'utf8' });
  expect(loaded.status, loaded.stderr).toBe(0);
  const marker = loaded.stdout.split('\n').find((line) => line.startsWith('CONFIG_THRESHOLDS='));
  expect(marker, loaded.stdout).toBeDefined();
  const snapshot = JSON.parse(marker!.slice('CONFIG_THRESHOLDS='.length)) as Record<
    string,
    Thresholds | null
  >;
  snapshots.set(key, snapshot);
  return snapshot;
};

describe('approved coverage floors', () => {
  it('accounts independently for every non-exempt package', () => {
    expect(Object.keys(PER_PACKAGE_THRESHOLDS).sort()).toEqual(Object.keys(APPROVED_FLOORS).sort());

    for (const [packageName, floor] of Object.entries(APPROVED_FLOORS)) {
      const actual = PER_PACKAGE_THRESHOLDS[packageName]!;
      if ('exact' in floor) {
        expect(actual, packageName).toEqual({ lines: floor.lines, branches: floor.branches });
      } else {
        expect(actual.lines, `${packageName} line floor`).toBeGreaterThanOrEqual(floor.lines);
        expect(actual.branches, `${packageName} branch floor`).toBeGreaterThanOrEqual(
          floor.branches,
        );
      }
    }
  });

  it('does not treat partial testcontainers coverage as a complete-suite floor', () => {
    expect(COVERAGE_POLICY['@app/testcontainers']).toMatchObject({
      exemption: expect.stringContaining('Docker provisioning tests are skipped'),
    });
    expect(PER_PACKAGE_THRESHOLDS).not.toHaveProperty('@app/testcontainers');
  });
});

describe('coverage threshold lane binding', () => {
  it.each([undefined, ...COVERAGE_LANES] as const)(
    'injects each threshold only for its complete-suite lane: %s',
    (lane) => {
      const effectiveLane = lane ?? 'unit';
      const snapshot = loadThresholdSnapshot(lane);
      for (const [packageName, expected] of Object.entries(PER_PACKAGE_THRESHOLDS)) {
        const entry = COVERAGE_POLICY[packageName];
        const shouldGate = entry && 'lane' in entry && entry.lane === effectiveLane;
        expect(snapshot[packageName], `${packageName} with ${lane ?? 'absent'} lane`).toEqual(
          shouldGate ? expected : null,
        );
      }
    },
  );

  it('treats an absent lane as unit and leaves infrastructure thresholds omitted', () => {
    const snapshot = loadThresholdSnapshot(undefined);

    expect(snapshot['@app/api']).toBeNull();
    expect(snapshot['@app/db']).toBeNull();
    expect(snapshot['@app/worker']).toBeNull();
    expect(snapshot['@app/web']).toEqual(APPROVED_FLOORS['@app/web']);
  });
});
