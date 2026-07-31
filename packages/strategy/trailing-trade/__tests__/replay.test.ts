import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { assertPreviewTickAgreement, type TickInput } from '@app/strategy-core';
import { FIXTURE_SCHEMA_VERSION } from '@app/strategy-core/replay';

import { trailingTrade, type TTBundle, type TTConfig, type TTState } from '../src/index.js';
import { fromSerialisableInput, SYNTHESISED_SCENARIOS } from '../../../../scripts/synthesise.js';

// Resolve the synthesised fixtures relative to this test file. The directory
// is committed; CI runs with the workspace checked out at the repo root, so
// the path holds whether vitest is invoked from the package or from `bun
// run test` at the root.
const SYNTHESISED_DIR = resolve(__dirname, '..', 'fixtures', 'replay', 'synthesised');

interface FixtureLineSerialised {
  readonly tick: number;
  readonly schemaVersion: number;
  readonly input: Parameters<typeof fromSerialisableInput>[0];
  readonly expected: ReturnType<typeof trailingTrade.tick>;
}

describe('trailingTrade — golden-fixture replay (synthesised)', () => {
  it('every committed scenario file matches the canonical name list', async () => {
    const files = (await readdir(SYNTHESISED_DIR))
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.replace(/\.jsonl$/, ''))
      .sort();
    const expected = [...SYNTHESISED_SCENARIOS].sort();
    expect(files).toEqual(expected);
  });

  it.each(SYNTHESISED_SCENARIOS.map((s) => [s] as const))(
    'replays %s with diff = 0',
    async (scenario) => {
      const path = resolve(SYNTHESISED_DIR, `${scenario}.jsonl`);
      const raw = await readFile(path, 'utf8');
      const lines = raw
        .split('\n')
        // Tolerate `# rationale: …` comment lines and trailing blanks.
        .filter((l) => l.trim().length > 0 && !l.startsWith('#'));
      // An empty / truncated fixture would otherwise pass with zero
      // assertions and silently drop scenario coverage.
      expect(lines.length).toBeGreaterThan(0);

      let threadedState: TTState | undefined;
      for (const line of lines) {
        const parsed = JSON.parse(line) as FixtureLineSerialised;
        expect(parsed.schemaVersion).toBe(FIXTURE_SCHEMA_VERSION);

        const input: TickInput<TTConfig, TTState, TTBundle> =
          threadedState === undefined
            ? fromSerialisableInput(parsed.input)
            : { ...fromSerialisableInput(parsed.input), state: threadedState };

        const actual = trailingTrade.tick(input);

        // Drift gate: every emitted decision must agree with trailingTrade's own
        // previewLevels (emitted ⟹ consistent). This custom loop does not use
        // core replayFixture, so the gate is called here directly.
        assertPreviewTickAgreement(trailingTrade, input, actual);

        // `events` is a derivation of `logs` (see audit-event.ts +
        // audit-event.test.ts) and is not in the frozen fixtures.
        // Stripping it here keeps the replay invariant focused on the
        // observable behaviour channels (decisions / nextState / logs /
        // metrics). If events ever drift independently of logs the
        // unit-test seam catches it, not replay.
        const { events: _omit, ...actualCore } = actual;

        // Deep-equal so a regression on any field — decision args, next-state
        // shape, log entries, metric values — surfaces as a single failing
        // assertion against the frozen fixture.
        expect(actualCore).toEqual({
          ...parsed.expected,
          // expected.nextState is a serialised TTState; parse it through the
          // schema so a fixture frozen before an additive-defaulted state
          // field still matches (the executor likewise parses persisted
          // state on load). decisions / logs / metrics stay an exact freeze.
          nextState: trailingTrade.stateSchema.parse(parsed.expected.nextState),
        });
        threadedState = actual.nextState;
      }
    },
  );
});
