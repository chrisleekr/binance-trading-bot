import { describe, expect, it } from 'vitest';
import { buildNotifyRegistry } from '../src/index.js';

describe('buildNotifyRegistry', () => {
  it('registers the expected provider set', () => {
    const r = buildNotifyRegistry();
    const names = r.list().map((p) => p.name);
    expect(names).toEqual(['slack', 'telegram', 'webhook']);
  });

  it('returns a fresh registry on each call', () => {
    const a = buildNotifyRegistry();
    const b = buildNotifyRegistry();
    expect(a).not.toBe(b);
  });
});
