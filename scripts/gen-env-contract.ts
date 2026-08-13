#!/usr/bin/env bun
/**
 * Generate `env-contract.json`, the machine-readable list of every environment
 * variable this repo reads. The scope is whatever `ENV_CATALOGUE` declares and
 * this script publishes all of it unfiltered: unwired reference templates under
 * `deploy/observability/` name variables nothing deployed reads, so they are
 * kept out of the catalogue rather than filtered out here.
 *
 * The helm chart at chrisleekr/helm-charts is synced by version only, so an
 * added or removed variable never reaches its ConfigMap or Secret and nothing
 * fails: an unmirrored variable does not render, and `helm template` still
 * succeeds. This file is published so the chart's parity check can fetch it at
 * the release tag it is syncing and diff the names, which is why it has to be
 * committed at the repo root and kept in step with the catalogue.
 *
 * The pure core (`buildEnvContract`/`renderEnvContract`/`envContractErrors`)
 * lives in `@app/core/env` so it is unit-testable; this file is the impure
 * shell: fs and argv only.
 *
 * Run: `bun run env-contract`  ·  Check: `bun run env-contract --check`
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEnvContract, renderEnvContract, envContractErrors } from '@app/core/env';

const main = (): void => {
  // `ENV_CONTRACT_ROOT` overrides where the contract is read and written, the
  // same way the CI guards take `GUARD_ROOT`. The self-test drives the real gate
  // over a fixture copy with it, so proving the gate can fail never puts the
  // tracked file at risk.
  const repoRoot =
    process.env['ENV_CONTRACT_ROOT'] ?? join(dirname(fileURLToPath(import.meta.url)), '..');
  const outPath = join(repoRoot, 'env-contract.json');

  const entries = buildEnvContract();

  // Checked in both modes: a misclassified variable must not be writable into
  // the committed file either, or the next `--check` run would pass on it.
  const errors = envContractErrors(entries);
  if (errors.length > 0) {
    console.error('env contract is not publishable:\n');
    for (const e of errors) console.error(`  ${e}`);
    console.error(
      '\nEvery variable is classified by `kind` in ENV_CATALOGUE (@app/core/env). ' +
        'See docs/contributing/coding-rules.md.',
    );
    process.exit(1);
  }

  const content = renderEnvContract(entries);
  const current = existsSync(outPath) ? readFileSync(outPath, 'utf8') : null;

  if (process.argv.includes('--check')) {
    if (current !== content) {
      console.error('stale: env-contract.json');
      console.error('\nRun `bun run env-contract` and commit the result.');
      process.exit(1);
    }
    console.log(`env-contract.json up to date (${entries.length} variables).`);
    return;
  }

  if (current === content) {
    console.log(`env-contract.json unchanged (${entries.length} variables).`);
    return;
  }
  writeFileSync(outPath, content);
  console.log(`wrote env-contract.json (${entries.length} variables).`);
};

if (import.meta.main) main();
