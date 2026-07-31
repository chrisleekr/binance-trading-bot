// Contract for the account-event notifier: gate on the singleton ops config,
// then fan out to the deduped union of every enabled notifier. @app/db is mocked
// so the decision logic is tested without Postgres.

import { describe, expect, it, beforeEach, vi } from 'vitest';
import pino from 'pino';
import type { NotifyProviderRegistry } from '@app/notify';

const h = vi.hoisted(() => ({
  get: vi.fn(),
  listAllEnabled: vi.fn(),
  listEnabledForAccount: vi.fn(),
}));
vi.mock('@app/db', () => ({
  repo: {
    opsNotifyConfig: { get: h.get },
    profileNotifiers: {
      listAllEnabled: h.listAllEnabled,
      listEnabledForAccount: h.listEnabledForAccount,
    },
  },
}));

import { asAccountId } from '@app/contracts';
import {
  createAccountNotifyEvent,
  createAccountNotifyEventBatch,
  isAccountEventEnabled,
} from '../../src/notifiers/account-notify-event.js';

// Two accounts of the operator. `ACC_B` is on the SAME Binance environment as
// `ACC_A` — the case a mode-keyed resolve gets wrong.
const ACC_A = asAccountId('00000000-0000-4000-8000-0000000000a1');
const ACC_B = asAccountId('00000000-0000-4000-8000-0000000000b1');

const silent = pino({ level: 'silent' });
const db = {} as never;

beforeEach(() => {
  h.get.mockReset();
  h.listAllEnabled.mockReset();
  h.listEnabledForAccount.mockReset();
});

describe('isAccountEventEnabled', () => {
  it('defaults to enabled when the config is empty', async () => {
    h.get.mockResolvedValue({ events: {} });
    expect(await isAccountEventEnabled(db, 'job-failed')).toBe(true);
  });

  it('honours a muted category', async () => {
    h.get.mockResolvedValue({ events: { 'job-failed': false } });
    expect(await isAccountEventEnabled(db, 'job-failed')).toBe(false);
  });

  it('fails open (enabled) when the stored map is malformed', async () => {
    h.get.mockResolvedValue({ events: { 'job-failed': 'yes' } });
    expect(await isAccountEventEnabled(db, 'job-failed')).toBe(true);
  });
});

describe('createAccountNotifyEvent', () => {
  const registryWith = (send: ReturnType<typeof vi.fn>): NotifyProviderRegistry =>
    ({ get: (name: string) => (name === 'slack' ? { name: 'slack', send } : undefined) }) as never;

  it('does not send when the category is muted', async () => {
    h.get.mockResolvedValue({ events: { 'job-failed': false } });
    const send = vi.fn(async () => undefined);
    await createAccountNotifyEvent({ db, notifyProviders: registryWith(send), logger: silent })({
      category: 'job-failed',
      body: 'a job died',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('fans out to the deduped notifier union when subscribed', async () => {
    h.get.mockResolvedValue({ events: {} });
    h.listAllEnabled.mockResolvedValue([
      { provider: 'slack', config: { channel: '#a' }, secrets: { url: 'u' }, enabled: true },
      // Exact duplicate transport — must be deduped to a single send.
      { provider: 'slack', config: { channel: '#a' }, secrets: { url: 'u' }, enabled: true },
    ]);
    const send = vi.fn(async () => undefined);
    await createAccountNotifyEvent({ db, notifyProviders: registryWith(send), logger: silent })({
      category: 'job-failed',
      body: 'db-backup failed',
      fields: [{ label: 'Job', value: 'db-backup' }],
    });
    expect(send).toHaveBeenCalledTimes(1);
    const arg = send.mock.calls[0]?.[0] as {
      message: {
        severity: string;
        topic: string;
        title: string;
        body: string;
        fields: { label: string; value: string }[];
      };
    };
    expect(arg.message).toMatchObject({
      severity: 'error',
      topic: 'job-failed',
      title: 'Background job failed',
      body: 'db-backup failed',
    });
    expect(arg.message.fields).toEqual([{ label: 'Job', value: 'db-backup' }]);
  });

  it('no-ops when no notifiers are configured anywhere', async () => {
    h.get.mockResolvedValue({ events: {} });
    h.listAllEnabled.mockResolvedValue([]);
    const send = vi.fn(async () => undefined);
    await createAccountNotifyEvent({ db, notifyProviders: registryWith(send), logger: silent })({
      category: 'job-failed',
      body: 'nothing to send to',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('account-scoped resolve excludes notifiers of the other environment', async () => {
    // An event carrying an `accountId` concerns one Binance account — and an
    // account has exactly one environment, so a testnet orphan can never reach a
    // live account's channels. Fanning out to every notifier the operator owns
    // would alert the live channel about a testnet-only event.
    h.get.mockResolvedValue({ events: {} });
    h.listEnabledForAccount.mockResolvedValue([
      { provider: 'slack', config: { channel: '#test' }, secrets: { url: 'u' }, enabled: true },
    ]);
    const send = vi.fn(async () => undefined);
    const outcome = await createAccountNotifyEvent({
      db,
      notifyProviders: registryWith(send),
      logger: silent,
    })({ category: 'orphan-order', accountId: ACC_A, body: 'an untracked testnet order' });

    expect(h.listEnabledForAccount).toHaveBeenCalledWith(db, ACC_A);
    // The un-scoped union must not be consulted at all — reading it and then
    // filtering in memory would still leak the other account's rows on a miss.
    expect(h.listAllEnabled).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0]?.[0] as { config: { channel: string } }).config.channel).toBe(
      '#test',
    );
    expect(outcome).toBe('delivered');
  });

  it('does not cross-alert two accounts on the SAME environment', async () => {
    // The case a mode-keyed resolve gets wrong: both accounts are live, so
    // narrowing by environment would hand account A's untracked order to account
    // B's Slack. Each event resolves against its own account and nothing else.
    h.get.mockResolvedValue({ events: {} });
    h.listEnabledForAccount.mockImplementation(async (_db: unknown, accountId: string) =>
      accountId === ACC_A
        ? [{ provider: 'slack', config: { channel: '#a' }, secrets: { url: 'ua' }, enabled: true }]
        : [{ provider: 'slack', config: { channel: '#b' }, secrets: { url: 'ub' }, enabled: true }],
    );
    const send = vi.fn(async () => undefined);
    const notify = createAccountNotifyEvent({
      db,
      notifyProviders: registryWith(send),
      logger: silent,
    });
    await notify({ category: 'orphan-order', accountId: ACC_A, body: "A's orphan" });
    await notify({ category: 'orphan-order', accountId: ACC_B, body: "B's orphan" });

    const channels = send.mock.calls.map(
      (c) => (c[0] as { config: { channel: string }; message: { body: string } }).config.channel,
    );
    const bodies = send.mock.calls.map((c) => (c[0] as { message: { body: string } }).message.body);
    expect(channels).toEqual(['#a', '#b']);
    expect(bodies).toEqual(["A's orphan", "B's orphan"]);
  });

  it('reports no-notifier (not a failure) when the account has no notifier at all', async () => {
    // The caller distinguishes these: a gap is a durable trace, a failure is a
    // retry. Collapsing them would either spam the log or drop the alert.
    h.get.mockResolvedValue({ events: {} });
    h.listEnabledForAccount.mockResolvedValue([]);
    const send = vi.fn(async () => undefined);
    const outcome = await createAccountNotifyEvent({
      db,
      notifyProviders: registryWith(send),
      logger: silent,
    })({ category: 'orphan-order', accountId: ACC_A, body: 'nobody to tell' });
    expect(send).not.toHaveBeenCalled();
    expect(outcome).toBe('no-notifier');
  });

  it('reports muted when the operator has turned the category off', async () => {
    h.get.mockResolvedValue({ events: { 'orphan-order': false } });
    const send = vi.fn(async () => undefined);
    const outcome = await createAccountNotifyEvent({
      db,
      notifyProviders: registryWith(send),
      logger: silent,
    })({ category: 'orphan-order', accountId: ACC_A, body: 'muted' });
    expect(send).not.toHaveBeenCalled();
    expect(outcome).toBe('muted');
  });
});

describe('createAccountNotifyEventBatch', () => {
  const registryWith = (send: ReturnType<typeof vi.fn>): NotifyProviderRegistry =>
    ({ get: (name: string) => (name === 'slack' ? { name: 'slack', send } : undefined) }) as never;

  it('reads the gate and the notifier set ONCE for the whole batch', async () => {
    // The gate and the resolve give the same answer for every event of one
    // account, so paying for them per event is N round trips for one answer.
    h.get.mockResolvedValue({ events: {} });
    h.listEnabledForAccount.mockResolvedValue([
      { provider: 'slack', config: { channel: '#a' }, secrets: { url: 'u' }, enabled: true },
    ]);
    const send = vi.fn(async () => undefined);
    const outcomes = await createAccountNotifyEventBatch({
      db,
      notifyProviders: registryWith(send),
      logger: silent,
    })({
      category: 'orphan-order',
      accountId: ACC_A,
      events: [{ body: 'orphan 1' }, { body: 'orphan 2' }, { body: 'orphan 3' }],
    });

    expect(h.get).toHaveBeenCalledTimes(1);
    expect(h.listEnabledForAccount).toHaveBeenCalledTimes(1);
    // The sends themselves still happen per event, one at a time (notifier rate
    // limits), and each event gets its own outcome, in order.
    expect(send).toHaveBeenCalledTimes(3);
    expect(outcomes).toEqual(['delivered', 'delivered', 'delivered']);
  });

  it('reports the shared outcome for every event when the gate or the resolve settles it', async () => {
    h.get.mockResolvedValue({ events: { 'orphan-order': false } });
    const send = vi.fn(async () => undefined);
    const outcomes = await createAccountNotifyEventBatch({
      db,
      notifyProviders: registryWith(send),
      logger: silent,
    })({
      category: 'orphan-order',
      accountId: ACC_A,
      events: [{ body: 'one' }, { body: 'two' }],
    });
    expect(outcomes).toEqual(['muted', 'muted']);
    expect(send).not.toHaveBeenCalled();
    // Muted before the resolve: a muted category costs no notifier read at all.
    expect(h.listEnabledForAccount).not.toHaveBeenCalled();
  });
});
