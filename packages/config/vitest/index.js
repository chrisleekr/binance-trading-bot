// Shared Vitest config factory. Per-package vitest.config.ts:
//   `export default defineProject()`                 — defaults, no thresholds.
//   `export default defineProject({ packageName: '@app/foo' })`
//                                                     — inherits the per-glob
//                                                       coverage thresholds for
//                                                       that package from
//                                                       PER_PACKAGE_THRESHOLDS.

import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

// Per-package coverage thresholds. The runtime contract is "lines / branches" —
// Vitest's v8 provider checks both. Strategies and money-math primitives sit at
// 100% because a regression is a money-correctness regression; web is gated at a
// lower bar because its component tree is partly view-glue.
//
// Every entry here MUST be wired by the package's own vitest.config (pass
// `packageName` to defineProject, or for web's custom config source
// `coverageThresholdsFor`). A listed-but-unwired package is a dead gate that
// never fires; `__tests__/coverage-thresholds.test.ts` enforces this invariant.
//
// db/api/worker are deliberately ABSENT: their real coverage comes from
// `describe.skipIf(!DATABASE_TEST_URL)` integration/isolation suites that only
// run in the Postgres-backed jobs, and those jobs do not collect coverage — so a
// threshold could only be checked in the no-DB unit job, where it would fail on
// skipped suites (db ~23%, api ~27%, worker ~76% lines). contracts is absent
// because its branch coverage (≈89%) sits just under the intended 90 and the
// gap is in re-export barrels, not testable logic. Re-add any of these only
// alongside a job that both runs its full suite AND collects coverage (#488).
export const PER_PACKAGE_THRESHOLDS = Object.freeze({
  '@app/strategy-core': { lines: 100, branches: 100 },
  '@app/strategy-trailing-trade': { lines: 100, branches: 100 },
  '@app/strategy-momentum': { lines: 100, branches: 100 },
  '@app/strategy-rebalance': { lines: 100, branches: 100 },
  '@app/indicators': { lines: 100, branches: 100 },
  '@app/discovery': { lines: 100, branches: 100 },
  '@app/binance': { lines: 100, branches: 100 },
  // The backtest ENGINE is an offline analysis tool, not live-money tick logic,
  // so it is floor-gated (regression guard) rather than at the strategy plugins'
  // 100%. The floor sits a margin below current (≈99 lines / ≈86 branches) so a
  // routine helper addition does not red the gate, while real erosion still
  // fails it. Raise toward 100 only alongside the edge-case tests that close it.
  '@app/strategy-backtest': { lines: 98, branches: 85 },
  // The pure advisor logic in `advisor.ts` sits near 100, but the provider
  // clients (`providers/anthropic.ts`, `providers/openai-compatible.ts`) own the
  // network path, only partly unit-mocked, so the package floor sits a margin
  // below current — a regression guard, like `@app/strategy-backtest`.
  '@app/llm': { lines: 80, branches: 82 },
  '@app/web': { lines: 80, branches: 70 },
});

/**
 * Returns the coverage threshold map for a given package name, or null when
 * none is registered. Exposed so consumers can opt in:
 *
 *   defineProject({ packageName: '@app/strategy-trailing-trade' })
 *
 * applies the matching thresholds. Consumers that don't pass a packageName
 * (the historical default) keep their existing behaviour — no thresholds.
 */
export function coverageThresholdsFor(packageName) {
  return PER_PACKAGE_THRESHOLDS[packageName] ?? null;
}

export function defineProject(overrides = {}) {
  const { packageName, test: testOverrides = {}, ...rest } = overrides;
  // Pull `coverage` off `testOverrides` so a consumer override merges into
  // (rather than replaces) the coverage block — otherwise the per-package
  // thresholds we inject below get clobbered when a package overrides any
  // unrelated coverage option.
  const { coverage: coverageOverrides = {}, ...restTestOverrides } = testOverrides;
  const thresholds = packageName ? coverageThresholdsFor(packageName) : null;

  return defineConfig({
    plugins: [tsconfigPaths()],
    test: {
      include: ['__tests__/**/*.test.{ts,tsx}'],
      exclude: ['**/node_modules/**', '**/dist/**', '**/.turbo/**'],
      environment: 'node',
      passWithNoTests: true,
      // zod 4 re-exports `z` from a nested module which trips Vitest's SSR
      // externalization in Bun-on-Alpine; force it to go through Vite's transformer.
      server: { deps: { inline: [/zod/] } },
      // Emit JUnit XML alongside the default reporter so CI can annotate
      // per-test failures from one shared location. The path is package-
      // local so turbo's `outputs: ['test-results/**']` caches it cleanly.
      reporters: ['default', ['junit', { outputFile: 'test-results/junit.xml' }]],
      coverage: {
        provider: 'v8',
        reporter: ['text', 'lcov'],
        ...coverageOverrides,
        // thresholds applied last so a consumer cannot accidentally weaken
        // the gate by spreading in a `coverage` block of their own.
        ...(thresholds ? { thresholds } : {}),
      },
      ...restTestOverrides,
    },
    ...rest,
  });
}
