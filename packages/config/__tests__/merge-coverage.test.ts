import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mergeCoverage, writeMergedCoverage } from '../../../scripts/ci/merge-coverage.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

let fixtureRoot = '';

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(REPO_ROOT, '.coverage-merge-test-'));
});

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

const writeWorkspaceReport = (
  workspace: string,
  packageName: string,
  lane: string,
  sources: readonly string[],
): string => {
  const workspaceRoot = join(fixtureRoot, workspace);
  const report = join(workspaceRoot, 'coverage', lane, 'lcov.info');
  mkdirSync(join(workspaceRoot, 'coverage', lane), { recursive: true });
  writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify({ name: packageName }));
  writeFileSync(
    report,
    sources.map((source) => `TN:\nSF:${source}\nDA:1,1\nend_of_record\n`).join(''),
  );
  return report;
};

describe('coverage merger', () => {
  it('normalizes source paths to the repository and sorts records deterministically', () => {
    const api = writeWorkspaceReport('apps/api', '@fixture/api', 'integration', [
      'src/z.ts',
      'src/a.ts',
    ]);
    const core = writeWorkspaceReport('packages/core', '@fixture/core', 'unit', ['src/core.ts']);
    const policy = {
      '@fixture/api': { lane: 'integration' },
      '@fixture/core': { lane: 'unit' },
    };

    const forward = mergeCoverage({ root: fixtureRoot, policy, inputs: [api, core] });
    const reverse = mergeCoverage({ root: fixtureRoot, policy, inputs: [core, api] });

    expect(reverse.lcov).toBe(forward.lcov);
    expect(forward.lcov.match(/^SF:.+$/gm)).toEqual([
      'SF:apps/api/src/a.ts',
      'SF:apps/api/src/z.ts',
      'SF:packages/core/src/core.ts',
    ]);
  });

  it('rejects duplicate normalized source paths', () => {
    const sharedSource = join(fixtureRoot, 'shared.ts');
    const api = writeWorkspaceReport('apps/api', '@fixture/api', 'integration', [sharedSource]);
    const core = writeWorkspaceReport('packages/core', '@fixture/core', 'unit', [sharedSource]);

    expect(() =>
      mergeCoverage({
        root: fixtureRoot,
        policy: {
          '@fixture/api': { lane: 'integration' },
          '@fixture/core': { lane: 'unit' },
        },
        inputs: [api, core],
      }),
    ).toThrow('duplicate lcov source shared.ts');
  });

  it('rejects a missing required workspace report', () => {
    const api = writeWorkspaceReport('apps/api', '@fixture/api', 'integration', ['src/app.ts']);

    expect(() =>
      mergeCoverage({
        root: fixtureRoot,
        policy: {
          '@fixture/api': { lane: 'integration' },
          '@fixture/core': { lane: 'unit' },
        },
        inputs: [api],
      }),
    ).toThrow('missing complete-suite lcov for: @fixture/core');
  });

  it('discovers declared workspace reports and writes the production output', () => {
    writeFileSync(
      join(fixtureRoot, 'package.json'),
      JSON.stringify({ workspaces: ['apps/*', 'packages/*'] }),
    );
    writeWorkspaceReport('apps/api', '@fixture/api', 'integration', ['src/app.ts']);
    writeWorkspaceReport('packages/core', '@fixture/core', 'unit', ['src/core.ts']);
    writeWorkspaceReport('packages/testcontainers', '@fixture/testcontainers', 'integration', [
      'src/wrapper.ts',
    ]);

    const result = writeMergedCoverage({
      root: fixtureRoot,
      policy: {
        '@fixture/api': { lane: 'integration' },
        '@fixture/core': { lane: 'unit' },
        '@fixture/testcontainers': {
          exemption: 'Docker provisioning tests are not executed in this lane.',
          lane: 'integration',
        },
      },
    });
    const expected = [
      'TN:\nSF:apps/api/src/app.ts\nDA:1,1\nend_of_record\n',
      'TN:\nSF:packages/core/src/core.ts\nDA:1,1\nend_of_record\n',
    ].join('');

    expect(result).toEqual({ lcov: expected, sourceCount: 2, workspaceCount: 2 });
    expect(readFileSync(join(fixtureRoot, 'coverage/lcov.info'), 'utf8')).toBe(expected);
  });
});
