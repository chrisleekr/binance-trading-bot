// Contract for the profile-event notifier: gate on the profile's notify_events
// subscription, then fan out to its resolved notifiers. @app/db is mocked so the
// helper's decision logic is tested without Postgres.

import { describe, expect, it, beforeEach, vi } from 'vitest';
import pino from 'pino';
import type { AnyNotifyProvider, NotifyProviderRegistry } from '@app/notify';

const h = vi.hoisted(() => ({ findById: vi.fn(), listForProfile: vi.fn() }));
vi.mock('@app/db', () => ({
  profileRepo: vi.fn(async () => ({
    profile: { findById: h.findById },
    profileNotifiers: { listForProfile: h.listForProfile },
  })),
}));

import { createNotifyEvent, isProfileEventEnabled } from '../../src/notifiers/notify-event.js';

const silent = pino({ level: 'silent' });
const db = {} as never;
const U = 'u1' as never;
const A = 'a1' as never;
const P = 'p1' as never;

beforeEach(() => {
  h.findById.mockReset();
  h.listForProfile.mockReset();
});

describe('isProfileEventEnabled', () => {
  it('defaults to enabled when the column is null', async () => {
    h.findById.mockResolvedValue({ notifyEvents: null });
    expect(await isProfileEventEnabled(db, U, A, P, 'discovery')).toBe(true);
  });

  it('honours a muted category and leaves the others on', async () => {
    h.findById.mockResolvedValue({ notifyEvents: { 'daily-loss-halt': false } });
    expect(await isProfileEventEnabled(db, U, A, P, 'daily-loss-halt')).toBe(false);
    expect(await isProfileEventEnabled(db, U, A, P, 'edge-decay-warning')).toBe(true);
  });

  it('reads a deleted profile as not subscribed', async () => {
    h.findById.mockResolvedValue(null);
    expect(await isProfileEventEnabled(db, U, A, P, 'alive')).toBe(false);
  });

  it('fails open (all-on) when the stored map is malformed', async () => {
    // A corrupt column must not silently drop capital-safety alerts.
    h.findById.mockResolvedValue({ notifyEvents: { 'daily-loss-halt': 'yes' } });
    expect(await isProfileEventEnabled(db, U, A, P, 'daily-loss-halt')).toBe(true);
  });
});

describe('createNotifyEvent', () => {
  const registryWith = (
    send: ReturnType<typeof vi.fn<AnyNotifyProvider['send']>>,
  ): NotifyProviderRegistry =>
    ({ get: (name: string) => (name === 'slack' ? { name: 'slack', send } : undefined) }) as never;

  it('does not send when the category is muted', async () => {
    h.findById.mockResolvedValue({ notifyEvents: { 'daily-loss-halt': false } });
    const send = vi.fn<AnyNotifyProvider['send']>(async () => undefined);
    await createNotifyEvent({ db, notifyProviders: registryWith(send), logger: silent })({
      category: 'daily-loss-halt',
      operatorId: U,
      accountId: A,
      profileId: P,
      body: 'halted',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('fans out to the profile’s enabled notifiers when subscribed', async () => {
    h.findById.mockResolvedValue({ notifyEvents: null, name: 'RealNet-Momentum' });
    h.listForProfile.mockResolvedValue([
      { provider: 'slack', config: { channel: '#a' }, secrets: { url: 'u' }, enabled: true },
    ]);
    const send = vi.fn<AnyNotifyProvider['send']>(async () => undefined);
    await createNotifyEvent({ db, notifyProviders: registryWith(send), logger: silent })({
      category: 'edge-decay-warning',
      operatorId: U,
      accountId: A,
      profileId: P,
      body: 'edge down',
      fields: [{ label: 'Live profit factor', value: '0.8' }],
    });
    expect(send).toHaveBeenCalledTimes(1);
    const arg = send.mock.calls[0]?.[0];
    if (!arg) throw new Error('expected one profile notification');
    expect(arg.config).toMatchObject({ channel: '#a', url: 'u' });
    expect(arg.message).toMatchObject({
      severity: 'warn',
      topic: 'edge-decay-warning',
      title: 'Edge decay warning',
      profile: 'RealNet-Momentum',
      body: 'edge down',
    });
    expect(arg.message.fields).toEqual([{ label: 'Live profit factor', value: '0.8' }]);
  });

  it('no-ops when the profile has no notifiers', async () => {
    h.findById.mockResolvedValue({ notifyEvents: null });
    h.listForProfile.mockResolvedValue([]);
    const send = vi.fn(async () => undefined);
    await createNotifyEvent({ db, notifyProviders: registryWith(send), logger: silent })({
      category: 'discovery',
      operatorId: U,
      accountId: A,
      profileId: P,
      body: 'added',
    });
    expect(send).not.toHaveBeenCalled();
  });
});
