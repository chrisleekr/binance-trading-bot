// Criterion 4: under LIVE_DEMO the worker no-ops all notifier dispatch, so even
// if the seed snapshot carries real webhooks nothing leaks. Both fan-out entry
// points must go quiet: the per-profile notifier (createNotifyEvent) and the
// account/ops notifier (createAccountNotifyEvent). @app/db is mocked so the
// decision logic is exercised without Postgres.
//
// The suppression is expected to ride on a `liveDemo` flag in each factory's
// deps. Each describe pairs a control (flag off → dispatches) with the locked
// case (flag on → no send, and the DB gate is never even read).
//
// RED: the factories ignore any liveDemo flag today, so the "on" case still
// resolves notifiers and calls send.

import { describe, expect, it, beforeEach, vi } from 'vitest';
import pino from 'pino';
import type { NotifyProviderRegistry } from '@app/notify';

const h = vi.hoisted(() => ({
  findById: vi.fn(),
  listForProfile: vi.fn(),
  get: vi.fn(),
  listAllEnabled: vi.fn(),
  listEnabledForAccount: vi.fn(),
}));
vi.mock('@app/db', () => ({
  profileRepo: vi.fn(async () => ({
    profile: { findById: h.findById },
    profileNotifiers: { listForProfile: h.listForProfile },
  })),
  repo: {
    opsNotifyConfig: { get: h.get },
    profileNotifiers: {
      listAllEnabled: h.listAllEnabled,
      listEnabledForAccount: h.listEnabledForAccount,
    },
  },
}));

import { createNotifyEvent } from '../../src/notifiers/notify-event.js';
import { createAccountNotifyEvent } from '../../src/notifiers/account-notify-event.js';
import { dispatchNotify } from '../../src/notifiers/dispatch.js';
import { emergencyNotify } from '../../src/executor/decisions/emergency-notify.js';

const silent = pino({ level: 'silent' });
const db = {} as never;
const U = 'u1' as never;
const A = 'a1' as never;
const P = 'p1' as never;

const registryWith = (send: ReturnType<typeof vi.fn>): NotifyProviderRegistry =>
  ({ get: (name: string) => (name === 'slack' ? { name: 'slack', send } : undefined) }) as never;

const slackRow = {
  provider: 'slack',
  config: { channel: '#a' },
  secrets: { url: 'u' },
  enabled: true,
};

beforeEach(() => {
  h.findById.mockReset();
  h.listForProfile.mockReset();
  h.get.mockReset();
  h.listAllEnabled.mockReset();
  h.listEnabledForAccount.mockReset();
});

describe('createNotifyEvent under LIVE_DEMO', () => {
  const subscribe = (): void => {
    h.findById.mockResolvedValue({ notifyEvents: null, name: 'Demo' });
    h.listForProfile.mockResolvedValue([slackRow]);
  };

  it('control: dispatches to the profile notifier when liveDemo is off', async () => {
    subscribe();
    const send = vi.fn(async () => undefined);
    await createNotifyEvent({ db, notifyProviders: registryWith(send), logger: silent })({
      category: 'edge-decay-warning',
      operatorId: U,
      accountId: A,
      profileId: P,
      body: 'edge down',
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('no-ops the profile notifier when liveDemo is on', async () => {
    subscribe();
    const send = vi.fn(async () => undefined);
    // Intended Phase-B deps field: `liveDemo`.
    await createNotifyEvent({
      db,
      notifyProviders: registryWith(send),
      logger: silent,
      liveDemo: true,
    } as never)({
      category: 'edge-decay-warning',
      operatorId: U,
      accountId: A,
      profileId: P,
      body: 'edge down',
    });
    expect(send).not.toHaveBeenCalled();
    // Dispatch is impossible without first reading the profile from the DB.
    expect(h.findById).not.toHaveBeenCalled();
  });
});

describe('createAccountNotifyEvent under LIVE_DEMO', () => {
  const subscribe = (): void => {
    h.get.mockResolvedValue({ events: {} });
    h.listAllEnabled.mockResolvedValue([slackRow]);
    h.listEnabledForAccount.mockResolvedValue([slackRow]);
  };

  it('control: dispatches to the account notifier when liveDemo is off', async () => {
    subscribe();
    const send = vi.fn(async () => undefined);
    await createAccountNotifyEvent({ db, notifyProviders: registryWith(send), logger: silent })({
      category: 'job-failed',
      body: 'a job died',
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('no-ops the account notifier when liveDemo is on', async () => {
    subscribe();
    const send = vi.fn(async () => undefined);
    await createAccountNotifyEvent({
      db,
      notifyProviders: registryWith(send),
      logger: silent,
      liveDemo: true,
    } as never)({
      category: 'job-failed',
      body: 'a job died',
    });
    expect(send).not.toHaveBeenCalled();
    expect(h.get).not.toHaveBeenCalled();
  });
});

// The chokepoint: dispatchNotify is the lowest common function every notifier
// caller routes through. Suppressing here makes suppression total regardless of
// which caller (factory, emergency-notify, disposal, cron) reached it.
describe('dispatchNotify under LIVE_DEMO', () => {
  const message = {
    severity: 'error',
    topic: 'x',
    title: 'x',
    body: 'x',
  } as never;

  it('control: dispatches and can record an undelivered trace when liveDemo is off', async () => {
    const send = vi.fn(async () => undefined);
    const onUndelivered = vi.fn(async () => undefined);
    const delivered = await dispatchNotify(
      { registry: registryWith(send), logger: silent },
      [{ providerName: 'slack', config: {} }] as never,
      message,
      onUndelivered,
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(delivered).toBe(1);
  });

  it('is a total no-op when liveDemo is on: no send, no undelivered trace', async () => {
    const send = vi.fn(async () => undefined);
    const onUndelivered = vi.fn(async () => undefined);
    const delivered = await dispatchNotify(
      { registry: registryWith(send), logger: silent, liveDemo: true },
      [{ providerName: 'slack', config: {} }] as never,
      message,
      onUndelivered,
    );
    expect(send).not.toHaveBeenCalled();
    expect(onUndelivered).not.toHaveBeenCalled();
    expect(delivered).toBe(0);
  });
});

// emergency-notify is a DIRECT dispatchNotify caller (not routed through a
// demo-gated factory). It must thread liveDemo so the real-money-failure alert
// is suppressed on a demo box.
describe('emergencyNotify under LIVE_DEMO', () => {
  const bindingsWith = (rows: readonly unknown[], recordNotifierGap: () => Promise<void>) =>
    ({
      persistence: {
        listEnabledNotifiers: async () => rows,
        recordNotifierGap,
      },
    }) as never;
  const args = {
    severity: 'error',
    topic: 'binance-emergency',
    title: 'Order failed',
    body: 'x',
  } as never;

  it('control: dispatches the emergency alert when liveDemo is off', async () => {
    const send = vi.fn(async () => undefined);
    await emergencyNotify(
      { notifyRegistry: registryWith(send), logger: silent } as never,
      bindingsWith([slackRow], async () => undefined),
      P,
      args,
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('no dispatch and no gap recorded when liveDemo is on', async () => {
    const send = vi.fn(async () => undefined);
    const recordGap = vi.fn(async () => undefined);
    await emergencyNotify(
      { notifyRegistry: registryWith(send), logger: silent, liveDemo: true } as never,
      bindingsWith([slackRow], recordGap),
      P,
      args,
    );
    expect(send).not.toHaveBeenCalled();
    expect(recordGap).not.toHaveBeenCalled();
  });
});
