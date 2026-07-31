import { afterEach, describe, expect, it, vi } from 'vitest';

import { sleep } from '../src/sleep/index.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('sleep', () => {
  it('resolves only after the elapsed timer fires', async () => {
    vi.useFakeTimers();
    let resolved = false;
    const p = sleep(1_000).then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(resolved).toBe(true);
  });

  it('resolves to undefined', async () => {
    vi.useFakeTimers();
    const p = sleep(0);
    await vi.advanceTimersByTimeAsync(0);
    await expect(p).resolves.toBeUndefined();
  });
});
