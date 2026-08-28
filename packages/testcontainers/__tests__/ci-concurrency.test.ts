// Pins the turbo fan-out cap on the two entry points that run every package at once.
//
// `turbo test` with no `--concurrency` starts as many package tasks as turbo's default allows, and each of those forks one vitest worker per core, so the machine ends up oversubscribed several times over and healthy tests fail on their own timeouts. `scripts/ci/typecheck.sh` already caps itself for the same class of reason (aggregate heap OOM), so the cap belongs on the invocation rather than in an env var a lane can forget to export.
//
// Deliberately NOT asserted over `scripts/ci/test-integration.sh`: that lane filters to two packages, provisions no containers (TESTCONTAINERS is unset, so both take the service-container reuse branch) and apps/api already serialises itself. A cap there relieves nothing and only serialises its build graph.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const LANES = [
  { file: 'scripts/ci/test-unit.sh', concurrency: 2 },
  { file: 'package.json', concurrency: 2 },
] as const;

/**
 * Collects the lines of a file that invoke `turbo test`, skipping shell comments so a rationale block that merely names the command cannot stand in for an invocation.
 *
 * The task name is closed off with `(?![\\w:-])` so `turbo test:e2e`, a different task with its own fan-out characteristics, is not swept in as an uncapped `turbo test`.
 *
 * @param source - The full text of a CI lane script or of the root package manifest.
 * @returns Every non-comment line invoking the `test` task through turbo, in file order.
 */
const turboTestLines = (source: string): readonly string[] =>
  source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#') && /\bturbo\s+test(?![\w:-])/.test(line));

describe.each(LANES)('$file turbo fan-out', ({ file, concurrency }) => {
  const lines = turboTestLines(readFileSync(join(REPO_ROOT, file), 'utf8'));

  it('caps every turbo test invocation', () => {
    // The floor is the vacuity guard: a renamed command would otherwise match nothing and pass the cap assertion over an empty list.
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toContain(`--concurrency=${concurrency}`);
    }
  });
});
