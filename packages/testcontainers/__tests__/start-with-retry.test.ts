// Docker-free fault injection for the container-start retry.
//
// testcontainers waits a fixed 10s for a started container's ports to be bound to the host: `inspectContainerUntilPortsExposed(inspectFn, containerId, timeout = 10_000)`, and all three of its call sites pass two arguments, so the window has no env knob to widen. Under a loaded CI runner the bind lands late and the whole lane dies on `Timed out after 10000ms while waiting for container ports to be bound to the host`, which is a scheduling artefact, not a fault in the image or the suite. A retry around the start thunk absorbs it. The retry must not also swallow a real fault, so a cause that never clears has to reach the caller as the same error object, unwrapped, and after a bounded number of attempts rather than forever.

import { describe, expect, it, vi } from 'vitest';

import { startWithRetry } from '../src/index.js';

const PORT_BIND_TIMEOUT =
  'Timed out after 10000ms while waiting for container ports to be bound to the host';

describe('startWithRetry', () => {
  it('returns the started container once a transient port-bind timeout stops recurring', async () => {
    const sentinel = { marker: 'started' };
    const start = vi.fn<() => Promise<typeof sentinel>>();
    start
      .mockRejectedValueOnce(new Error(PORT_BIND_TIMEOUT))
      .mockRejectedValueOnce(new Error(PORT_BIND_TIMEOUT))
      .mockResolvedValue(sentinel);

    await expect(startWithRetry(start)).resolves.toBe(sentinel);
    expect(start).toHaveBeenCalledTimes(3);
  });

  it('surfaces the original cause unwrapped when no attempt succeeds', async () => {
    // A missing manifest is permanent: retrying cannot fix it, and a wrapper error would hide the one line that names the fix.
    const cause = new Error('no matching manifest for linux/arm64');
    const start = vi.fn<() => Promise<never>>();
    start.mockRejectedValue(cause);

    const rejection = await startWithRetry(start).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(rejection).toBe(cause);
    expect(rejection).toHaveProperty('message', 'no matching manifest for linux/arm64');
    expect(start).toHaveBeenCalledTimes(3);
  });

  it('does not retry a start that succeeds first time', async () => {
    const sentinel = { marker: 'started' };
    const start = vi.fn<() => Promise<typeof sentinel>>();
    start.mockResolvedValue(sentinel);

    await expect(startWithRetry(start)).resolves.toBe(sentinel);
    expect(start).toHaveBeenCalledTimes(1);
  });
});
