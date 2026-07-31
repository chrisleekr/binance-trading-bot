import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findEnvFile, findRepoRoot, loadEnvFile, parseEnvFile } from '../../src/env/index.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'load-env-test-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('findRepoRoot', () => {
  it('returns the nearest ancestor that contains a .git marker', () => {
    mkdirSync(join(root, '.git'));
    const nested = join(root, 'packages', 'core', 'src');
    mkdirSync(nested, { recursive: true });

    expect(findRepoRoot(nested)).toBe(root);
  });

  it('accepts turbo.json as a monorepo-root marker', () => {
    writeFileSync(join(root, 'turbo.json'), '{}\n');
    const nested = join(root, 'apps', 'api', 'src');
    mkdirSync(nested, { recursive: true });

    expect(findRepoRoot(nested)).toBe(root);
  });

  it('treats a .git file (worktree marker) the same as a .git directory', () => {
    writeFileSync(join(root, '.git'), 'gitdir: /elsewhere\n');
    const nested = join(root, 'apps', 'api', 'src');
    mkdirSync(nested, { recursive: true });

    expect(findRepoRoot(nested)).toBe(root);
  });

  it('returns undefined when neither marker is present anywhere up the tree', () => {
    const nested = join(root, 'a', 'b');
    mkdirSync(nested, { recursive: true });

    expect(findRepoRoot(nested)).toBeUndefined();
  });
});

describe('findEnvFile', () => {
  it('returns the .env path when it sits in an ancestor directory', () => {
    const envPath = join(root, '.env');
    writeFileSync(envPath, 'DATABASE_URL=postgres://x\n');
    const nested = join(root, 'packages', 'core', 'src');
    mkdirSync(nested, { recursive: true });

    expect(findEnvFile(nested)).toBe(envPath);
  });

  it('prefers the nearest .env over a further ancestor', () => {
    writeFileSync(join(root, '.env'), 'X=root\n');
    const inner = join(root, 'apps', 'inner');
    mkdirSync(inner, { recursive: true });
    const innerEnv = join(inner, '.env');
    writeFileSync(innerEnv, 'X=inner\n');

    expect(findEnvFile(inner)).toBe(innerEnv);
  });

  it('returns undefined when no .env exists above startDir', () => {
    const nested = join(root, 'a', 'b');
    mkdirSync(nested, { recursive: true });

    expect(findEnvFile(nested)).toBeUndefined();
  });

  it('stops at stopDir and does not climb past the bounded ancestor', () => {
    const outerEnv = join(root, '.env');
    writeFileSync(outerEnv, 'OUTER=1\n');
    const bounded = join(root, 'project');
    mkdirSync(bounded);
    const nested = join(bounded, 'packages', 'core', 'src');
    mkdirSync(nested, { recursive: true });

    expect(findEnvFile(nested, bounded)).toBeUndefined();
  });

  it('still finds a .env that sits at stopDir itself', () => {
    const bounded = join(root, 'project');
    mkdirSync(bounded);
    const boundedEnv = join(bounded, '.env');
    writeFileSync(boundedEnv, 'INNER=1\n');
    const nested = join(bounded, 'packages', 'core', 'src');
    mkdirSync(nested, { recursive: true });

    expect(findEnvFile(nested, bounded)).toBe(boundedEnv);
  });
});

describe('parseEnvFile', () => {
  it('parses simple KEY=value pairs', () => {
    expect(
      parseEnvFile('DATABASE_URL=postgres://app:app@db/app\nREDIS_URL=redis://r:6379\n'),
    ).toEqual({
      DATABASE_URL: 'postgres://app:app@db/app',
      REDIS_URL: 'redis://r:6379',
    });
  });

  it('ignores comments and blank lines', () => {
    const body = '# top comment\n\nFOO=bar\n   # indented comment\nBAZ=qux\n';
    expect(parseEnvFile(body)).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('strips surrounding double and single quotes', () => {
    const body = 'A="hello"\nB=\'world\'\nC=plain\n';
    expect(parseEnvFile(body)).toEqual({ A: 'hello', B: 'world', C: 'plain' });
  });

  it('keeps `=` characters inside the value intact', () => {
    expect(parseEnvFile('TOKEN=abc=def=ghi\n')).toEqual({ TOKEN: 'abc=def=ghi' });
  });

  it('skips lines without an equals sign', () => {
    expect(parseEnvFile('not-an-assignment\nOK=1\n')).toEqual({ OK: '1' });
  });

  it('strips trailing carriage returns from Windows-edited files', () => {
    expect(parseEnvFile('A=1\r\nB=2\r\n')).toEqual({ A: '1', B: '2' });
  });
});

describe('loadEnvFile', () => {
  it('merges file entries into process.env without overwriting existing keys', () => {
    const envPath = join(root, '.env');
    writeFileSync(envPath, 'LOAD_ENV_TEST_NEW=fresh\nLOAD_ENV_TEST_EXISTING=fromfile\n');
    const original = process.env['LOAD_ENV_TEST_EXISTING'];
    process.env['LOAD_ENV_TEST_EXISTING'] = 'fromshell';

    try {
      loadEnvFile(envPath);
      expect(process.env['LOAD_ENV_TEST_NEW']).toBe('fresh');
      expect(process.env['LOAD_ENV_TEST_EXISTING']).toBe('fromshell');
    } finally {
      delete process.env['LOAD_ENV_TEST_NEW'];
      if (original === undefined) delete process.env['LOAD_ENV_TEST_EXISTING'];
      else process.env['LOAD_ENV_TEST_EXISTING'] = original;
    }
  });
});
