// Shared Vitest config factory. Every workspace passes its package name so the
// exhaustive coverage policy can bind its threshold to the CI lane that runs
// the complete suite.

import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import { coveragePolicyFor, SOURCE_COVERAGE_INCLUDE } from './coverage-policy.js';

export {
  COVERAGE_POLICY,
  coveragePolicyFor,
  PER_PACKAGE_THRESHOLDS,
  SOURCE_COVERAGE_INCLUDE,
} from './coverage-policy.js';

export function defineProject(overrides = {}) {
  const { packageName, test: testOverrides = {}, ...rest } = overrides;
  // Pull `coverage` off `testOverrides` so a consumer override merges into
  // (rather than replaces) the coverage block — otherwise the per-package
  // thresholds we inject below get clobbered when a package overrides any
  // unrelated coverage option.
  const { coverage: coverageOverrides = {}, ...restTestOverrides } = testOverrides;
  for (const field of ['include', 'exclude', 'ignoreClassMethods', 'reportsDirectory']) {
    if (Object.hasOwn(coverageOverrides, field)) {
      throw new Error(`defineProject: coverage.${field} is policy-owned and cannot be overridden`);
    }
  }
  const policy = packageName ? coveragePolicyFor(packageName) : null;
  const configuredCoverageLane = process.env['COVERAGE_LANE'];
  const coverageLane = configuredCoverageLane ?? 'unit';
  const thresholds =
    policy && 'thresholds' in policy && policy.lane === coverageLane ? policy.thresholds : null;

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
        include: SOURCE_COVERAGE_INCLUDE,
        ...(configuredCoverageLane
          ? { reportsDirectory: `coverage/${configuredCoverageLane}` }
          : {}),
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
