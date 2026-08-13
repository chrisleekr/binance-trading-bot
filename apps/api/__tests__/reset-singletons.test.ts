// Guards the fixture reset against the newest global singleton being forgotten.
//
// `resetSingletons` in `_helpers` restores every `check (id = 1)` row to its
// migration defaults, because those rows cannot be truncated — each repo throws
// when the row is missing. It carried only a comment asking the next author to
// keep it in step, and that is exactly what failed: `retention_config` shipped
// without being registered, so a suite that shortened a retention horizon leaked
// that horizon into every later suite in the process and, against a persistent
// DATABASE_TEST_URL, into every later run. The symptom is a test that passes on
// a fresh container and fails on the second run, which is the worst shape a
// fixture bug can take.
//
// The database is asked which singletons exist rather than a list being restated
// here, so adding a table is what arms the check — no second place to update.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HAS_INFRA, setupApp, type ApiFixture } from './_helpers.js';

const describeIfInfra = HAS_INFRA ? describe : describe.skip;

describeIfInfra('resetSingletons', () => {
  // setupApp lives in beforeAll, not in the test body: it provisions the shared
  // container and reseeds it, which runs past the 5s testTimeout under a full
  // package run. Only hookTimeout (60s here) covers that.
  let fx: ApiFixture;
  beforeAll(async () => {
    fx = await setupApp();
  });
  afterAll(async () => {
    await fx.cleanup();
  });

  it('restores every id = 1 singleton the schema defines', async () => {
    const { rows } = await fx.di.pool.query<{ table_name: string }>(/* sql */ `
      select distinct conrelid::regclass::text as table_name
      from pg_constraint
      where contype = 'c' and pg_get_constraintdef(oid) ~ '\\(id = 1\\)'
    `);
    const singletons = rows.map((r) => r.table_name).sort();
    // A vacuous pass would be indistinguishable from a correct one if the
    // query matched nothing, so require the ones that exist today.
    expect(singletons.length).toBeGreaterThanOrEqual(4);

    const helpers = await readFile(
      fileURLToPath(new URL('./_helpers.ts', import.meta.url)),
      'utf8',
    );
    const reset = /const resetSingletons[\s\S]*?\n};/.exec(helpers)?.[0] ?? '';
    expect(reset, 'resetSingletons not found in _helpers.ts').not.toBe('');

    const missing = singletons.filter((t) => !reset.includes(`insert into ${t} (id) values (1)`));
    expect(
      missing,
      'these singleton tables are not restored between tests, so one suite’s ' +
        'writes leak into the next — add them to resetSingletons in _helpers.ts',
    ).toEqual([]);
  });
});
