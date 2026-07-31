import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { bootstrapEnv } from '../../src/env/index.js';

const TEST_KEYS = ['BOOTSTRAP_TEST_DB', 'BOOTSTRAP_TEST_REDIS', 'BOOTSTRAP_TEST_PRESET'] as const;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bootstrap-env-test-'));
  for (const k of TEST_KEYS) Reflect.deleteProperty(process.env, k);
});

afterEach(() => {
  for (const k of TEST_KEYS) Reflect.deleteProperty(process.env, k);
  rmSync(root, { recursive: true, force: true });
});

const callerUrlFor = (dir: string): string => {
  mkdirSync(dir, { recursive: true });
  return pathToFileURL(join(dir, 'index.ts')).toString();
};

describe('bootstrapEnv', () => {
  it('host-dev path: loads the workspace-root .env into process.env', () => {
    mkdirSync(join(root, '.git'));
    writeFileSync(
      join(root, '.env'),
      'BOOTSTRAP_TEST_DB=postgres://test\nBOOTSTRAP_TEST_REDIS=redis://test\n',
    );
    const callerUrl = callerUrlFor(join(root, 'apps', 'api', 'src'));

    bootstrapEnv(callerUrl);

    expect(process.env['BOOTSTRAP_TEST_DB']).toBe('postgres://test');
    expect(process.env['BOOTSTRAP_TEST_REDIS']).toBe('redis://test');
  });

  it('container path: no .git / no turbo.json → no-op, no throw', () => {
    const callerUrl = callerUrlFor(join(root, 'app', 'src'));

    expect(() => bootstrapEnv(callerUrl)).not.toThrow();
    expect(process.env['BOOTSTRAP_TEST_DB']).toBeUndefined();
  });

  it('container path: marker present but no .env file → no-op', () => {
    writeFileSync(join(root, 'turbo.json'), '{}\n');
    const callerUrl = callerUrlFor(join(root, 'apps', 'api', 'src'));

    expect(() => bootstrapEnv(callerUrl)).not.toThrow();
    expect(process.env['BOOTSTRAP_TEST_DB']).toBeUndefined();
  });

  it('preserves pre-existing process.env values over file values', () => {
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.env'), 'BOOTSTRAP_TEST_PRESET=fromfile\n');
    process.env['BOOTSTRAP_TEST_PRESET'] = 'fromshell';
    const callerUrl = callerUrlFor(join(root, 'apps', 'worker', 'src'));

    bootstrapEnv(callerUrl);

    expect(process.env['BOOTSTRAP_TEST_PRESET']).toBe('fromshell');
  });
});
