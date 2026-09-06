import { existsSync } from 'node:fs';
import { parse } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { findEnvFile, findRepoRoot } from '../../src/env/index.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

const filesystemRoot = parse(process.cwd()).root;

beforeEach(() => {
  vi.mocked(existsSync).mockReset();
  vi.mocked(existsSync).mockReturnValue(false);
});

describe('filesystem-root termination', () => {
  it('returns undefined when the filesystem root has no repository marker', () => {
    expect(findRepoRoot(filesystemRoot)).toBeUndefined();
  });

  it('returns undefined when the filesystem root has no .env', () => {
    expect(findEnvFile(filesystemRoot)).toBeUndefined();
  });
});
