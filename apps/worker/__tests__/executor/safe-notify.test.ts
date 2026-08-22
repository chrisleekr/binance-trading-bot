import { describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import type { AnyNotifyProvider } from '@app/notify';
import { safeNotify } from '../../src/executor/safe-notify.js';

const logger = pino({ level: 'silent' });

const fakeProvider = (name: string, send: () => Promise<void>): AnyNotifyProvider =>
  ({ name, send }) as unknown as AnyNotifyProvider;

describe('safeNotify', () => {
  it('returns true when the provider send resolves', async () => {
    const send = vi.fn(async () => undefined);
    const provider = fakeProvider('slack', send);
    const ok = await safeNotify(
      provider,
      { severity: 'info', topic: 't', title: 'Test notification' },
      { webhook: 'https://x' },
      logger,
    );
    expect(ok).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]).toBeDefined();
  });

  it('returns false and swallows the error when the provider throws an Error', async () => {
    const provider = fakeProvider('slack', async () => {
      throw new Error('webhook 500');
    });
    const ok = await safeNotify(
      provider,
      { severity: 'error', topic: 't', title: 'Test notification' },
      {},
      logger,
    );
    expect(ok).toBe(false);
  });

  it('returns false when the provider throws a non-Error primitive (no rethrow)', async () => {
    const provider = fakeProvider('slack', async () => {
      throw 'string-only';
    });
    const ok = await safeNotify(
      provider,
      { severity: 'error', topic: 't', title: 'Test notification' },
      {},
      logger,
    );
    expect(ok).toBe(false);
  });

  it('returns false when the provider throws null/undefined (no rethrow)', async () => {
    const provider = fakeProvider('slack', async () => {
      throw undefined;
    });
    const ok = await safeNotify(
      provider,
      { severity: 'error', topic: 't', title: 'Test notification' },
      {},
      logger,
    );
    expect(ok).toBe(false);
  });
});
