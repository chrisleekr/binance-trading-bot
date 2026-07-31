import { afterEach, describe, expect, it, vi } from 'vitest';

import { installGracefulShutdown } from '../src/shutdown/index.js';

// The handler registers real process listeners and calls process.exit(); stub
// exit and strip the listeners between cases so tests don't leak into each other
// or actually terminate the runner.
describe('installGracefulShutdown', () => {
  afterEach(() => {
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
    vi.restoreAllMocks();
  });

  it('runs every shutdown exactly once even when two distinct signals fire', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const a = vi.fn().mockResolvedValue(undefined);
    const b = vi.fn().mockResolvedValue(undefined);

    installGracefulShutdown([a, b]);
    // SIGTERM and SIGINT register separate once-listeners; the `started` guard
    // must dedup so a SIGINT arriving during a SIGTERM drain is a no-op.
    process.emit('SIGTERM' as NodeJS.Signals);
    process.emit('SIGINT' as NodeJS.Signals);

    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('settles all shutdowns even if one rejects (one stuck drain cannot starve the rest)', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const bad = vi.fn().mockRejectedValue(new Error('boom'));
    const good = vi.fn().mockResolvedValue(undefined);

    installGracefulShutdown([bad, good]);
    process.emit('SIGTERM' as NodeJS.Signals);

    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
  });
});
