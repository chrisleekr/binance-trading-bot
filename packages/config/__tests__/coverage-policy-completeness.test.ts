import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { discoverWorkspaceRoots } from '../../../scripts/ci/workspaces.ts';
import { COVERAGE_POLICY } from '../vitest/index.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

const packageNames = (root: string): string[] =>
  discoverWorkspaceRoots(root)
    .map((workspace) => {
      const manifest = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')) as {
        name?: unknown;
      };
      if (typeof manifest.name !== 'string') {
        throw new Error(`workspace has no package name: ${workspace}`);
      }
      return manifest.name;
    })
    .sort();

const writePackage = (root: string, path: string, name: string): void => {
  const workspace = join(root, path);
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'package.json'), JSON.stringify({ name }));
};

describe('coverage policy workspace completeness', () => {
  it('accounts for every root-declared workspace', () => {
    expect(Object.keys(COVERAGE_POLICY).sort()).toEqual(packageNames(REPO_ROOT));
  });

  it('discovers a newly declared tools workspace and requires policy', () => {
    const root = mkdtempSync(join(REPO_ROOT, '.workspace-policy-test-'));
    fixtures.push(root);
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ workspaces: ['apps/*', 'e2e', 'tools/*'] }),
    );
    writePackage(root, 'apps/api', '@fixture/api');
    writePackage(root, 'e2e', '@fixture/e2e');
    writePackage(root, 'tools/audit', '@fixture/audit');

    const names = packageNames(root);
    const policy = { '@fixture/api': {}, '@fixture/e2e': {} };
    expect(names).toContain('@fixture/audit');
    expect(names.filter((name) => !(name in policy))).toEqual(['@fixture/audit']);
  });

  it('fails loudly on an unsupported workspace pattern', () => {
    const root = mkdtempSync(join(REPO_ROOT, '.workspace-policy-test-'));
    fixtures.push(root);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/**'] }));

    expect(() => discoverWorkspaceRoots(root)).toThrow(
      'unsupported workspace pattern: packages/**',
    );
  });
});
