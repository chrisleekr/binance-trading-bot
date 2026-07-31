import { describe, it, expect } from 'vitest';
import * as subpath from '@app/strategy-core/replay';
import * as barrel from '@app/strategy-core';

describe('replay subpath isolation', () => {
  it('exposes the replay harness via the @app/strategy-core/replay subpath', () => {
    expect(typeof subpath.replayFixture).toBe('function');
    expect(subpath.FIXTURE_SCHEMA_VERSION).toBe(1);
  });

  it('does not re-export replay symbols from the package index barrel', () => {
    expect('replayFixture' in barrel).toBe(false);
    expect((barrel as Record<string, unknown>).replayFixture).toBeUndefined();
    expect('FIXTURE_SCHEMA_VERSION' in barrel).toBe(false);
  });
});
