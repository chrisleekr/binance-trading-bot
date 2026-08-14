export const SOURCE_COVERAGE_INCLUDE = Object.freeze(['src/**/*.{ts,tsx}']);

// Floors are whole percentages at or below the measured complete-suite result so the
// gate rejects regressions without claiming precision Vitest does not enforce.
const active = (lane, lines, branches) =>
  Object.freeze({
    lane,
    include: SOURCE_COVERAGE_INCLUDE,
    thresholds: Object.freeze({ lines, branches }),
  });

export const COVERAGE_POLICY = Object.freeze({
  '@app/api': active('integration', 79, 73),
  '@app/server': active('unit', 17, 12),
  '@app/web': active('unit', 80, 70),
  '@app/worker': active('worker-integration', 88, 82),
  '@app/e2e': Object.freeze({
    exemption:
      'Playwright owns this test-only workspace, which has no product src tree for Vitest to measure.',
  }),
  '@app/binance': active('unit', 100, 100),
  '@app/config': Object.freeze({
    exemption:
      'This shared test-configuration workspace has no product src tree; its behavior is covered by invariant tests.',
  }),
  '@app/contracts': active('unit', 97, 89),
  '@app/core': active('unit', 94, 92),
  '@app/db': active('db-isolation', 82, 74),
  '@app/discovery': active('unit', 100, 100),
  '@app/indicators': active('unit', 100, 100),
  '@app/llm': active('unit', 80, 82),
  '@app/money': active('unit', 100, 100),
  '@app/notify': active('unit', 100, 97),
  '@app/observability': active('unit', 82, 56),
  '@app/strategy-backtest': active('unit', 98, 85),
  '@app/strategy-core': active('unit', 100, 100),
  '@app/strategy-momentum': active('unit', 100, 100),
  '@app/strategy-rebalance': active('unit', 100, 100),
  '@app/strategy-registry': active('unit', 100, 100),
  '@app/strategy-trailing-trade': active('unit', 100, 100),
  '@app/testcontainers': Object.freeze({
    exemption:
      'Docker provisioning tests are skipped in the integration lane, so its service-reuse coverage is not complete-suite evidence.',
    lane: 'integration',
  }),
});

export const PER_PACKAGE_THRESHOLDS = Object.freeze(
  Object.fromEntries(
    Object.entries(COVERAGE_POLICY).flatMap(([packageName, entry]) =>
      'thresholds' in entry ? [[packageName, entry.thresholds]] : [],
    ),
  ),
);

export function coveragePolicyFor(packageName) {
  return COVERAGE_POLICY[packageName] ?? null;
}
