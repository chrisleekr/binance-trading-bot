// The boot sequence decides which sign-in methods a process offers. The operator's rule is "an identity provider that is down at startup degrades, never crashes, and never leaves the instance with no way in", so each case here pins one branch of that rule.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { findSoleUser, listSignInProviders, checkDiscovery } = vi.hoisted(() => ({
  findSoleUser: vi.fn(),
  listSignInProviders: vi.fn(),
  checkDiscovery: vi.fn(),
}));

vi.mock('@app/db', async (importActual) => {
  const actual = await importActual<typeof import('@app/db')>();
  return {
    ...actual,
    repo: {
      ...actual.repo,
      authIdentity: { ...actual.repo.authIdentity, findSoleUser, listSignInProviders },
    },
  };
});
vi.mock('../../src/auth/single-sign-on.js', async (importActual) => ({
  ...(await importActual<typeof import('../../src/auth/single-sign-on.js')>()),
  checkDiscovery,
}));

import type { DI } from '../../src/di.js';
import {
  AUTH_INIT_TIMEOUT_MS,
  SINGLE_SIGN_ON_REPROBE_MS,
  settleSignInMethods,
  watchSingleSignOnRecovery,
} from '../../src/auth/boot.js';

const ISSUER = 'https://tenant.example.test/';

interface Options {
  readonly passwordSignIn: boolean;
  readonly singleSignOnConfigured?: boolean;
  readonly singleSignOnAvailable: boolean;
  readonly authReady?: Promise<unknown>;
}

const makeDi = (o: Options) => {
  const record = vi.fn(async () => undefined);
  const setAvailable = vi.fn();
  const rebuiltAuth = { $context: Promise.resolve({}) };
  const rebuildAuth = vi.fn(() => rebuiltAuth);
  const security = {
    singleSignOn: o.singleSignOnConfigured === false ? null : { issuer: ISSUER },
    singleSignOnAvailable: o.singleSignOnAvailable,
    passwordSignIn: o.passwordSignIn,
    passwordSignInForced: false,
    events: { record },
    metrics: { singleSignOnAvailable: { set: setAvailable } },
  };
  const di = {
    db: {},
    security,
    auth: { $context: o.authReady ?? Promise.resolve({}) },
    rebuildAuth,
    logger: { error: vi.fn(), warn: vi.fn() },
  } as unknown as DI;
  return { di, security, record, rebuildAuth, rebuiltAuth, setAvailable };
};

const eventsOf = (record: ReturnType<typeof vi.fn>): unknown[] =>
  record.mock.calls.map((c) => (c[0] as { event: string }).event);

describe('settleSignInMethods', () => {
  beforeEach(() => {
    findSoleUser.mockResolvedValue({ id: 'operator-1' });
    listSignInProviders.mockResolvedValue(['credential']);
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('records an unreachable provider and still boots', async () => {
    const { di, record } = makeDi({ passwordSignIn: true, singleSignOnAvailable: false });
    await settleSignInMethods(di, { ok: false, reason: 'unreachable' });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'single-sign-on-unavailable',
        reason: 'provider_unavailable',
      }),
    );
  });

  it('keeps an issuer mismatch distinct from an outage, since only the operator can fix it', async () => {
    const { di, record } = makeDi({ passwordSignIn: true, singleSignOnAvailable: false });
    await settleSignInMethods(di, { ok: false, reason: 'issuer_mismatch' });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'single-sign-on-unavailable', reason: 'issuer_mismatch' }),
    );
  });

  it('records nothing about the provider when discovery succeeded', async () => {
    const { di, record } = makeDi({ passwordSignIn: true, singleSignOnAvailable: true });
    await settleSignInMethods(di, {
      ok: true,
      discoveryUrl: `${ISSUER}.well-known/openid-configuration`,
    });
    expect(eventsOf(record)).not.toContain('single-sign-on-unavailable');
  });

  it('forces password sign-in on when single sign-on was the only way in and is down', async () => {
    listSignInProviders.mockResolvedValue(['credential', 'oidc']);
    const { di, security, record, rebuildAuth, rebuiltAuth } = makeDi({
      passwordSignIn: false,
      singleSignOnAvailable: false,
    });
    await settleSignInMethods(di, { ok: false, reason: 'unreachable' });
    expect(security.passwordSignIn).toBe(true);
    expect(security.passwordSignInForced).toBe(true);
    expect(rebuildAuth).toHaveBeenCalledOnce();
    expect(di.auth).toBe(rebuiltAuth);
    expect(eventsOf(record)).toContain('sign-in-method-fallback');
  });

  it('leaves password sign-in off while a linked provider is reachable', async () => {
    listSignInProviders.mockResolvedValue(['oidc']);
    const { di, security, record, rebuildAuth } = makeDi({
      passwordSignIn: false,
      singleSignOnAvailable: true,
    });
    await settleSignInMethods(di, { ok: true, discoveryUrl: 'x' });
    expect(security.passwordSignIn).toBe(false);
    expect(rebuildAuth).not.toHaveBeenCalled();
    expect(eventsOf(record)).not.toContain('sign-in-method-fallback');
  });

  it('forces password on when the provider is reachable but the operator never linked it', async () => {
    listSignInProviders.mockResolvedValue(['credential']);
    const { di, security } = makeDi({ passwordSignIn: false, singleSignOnAvailable: true });
    await settleSignInMethods(di, { ok: true, discoveryUrl: 'x' });
    expect(security.passwordSignInForced).toBe(true);
  });

  it('tells the operator to run the reset command when they have no password and the provider is down', async () => {
    listSignInProviders.mockResolvedValue(['oidc']);
    const { di, security, record, rebuildAuth } = makeDi({
      passwordSignIn: true,
      singleSignOnAvailable: false,
    });
    await settleSignInMethods(di, { ok: false, reason: 'unreachable' });
    expect(rebuildAuth).not.toHaveBeenCalled();
    expect(security.passwordSignInForced).toBe(false);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'sign-in-method-fallback',
        detail: expect.objectContaining({ remedy: 'run reset-password' }),
      }),
    );
  });

  it('records no fallback when the password reaches the operator', async () => {
    const { di, record } = makeDi({ passwordSignIn: true, singleSignOnAvailable: false });
    await settleSignInMethods(di, { ok: false, reason: 'unreachable' });
    expect(eventsOf(record)).not.toContain('sign-in-method-fallback');
  });

  it('checks nothing about the operator before onboarding', async () => {
    findSoleUser.mockResolvedValue(null);
    const { di, record } = makeDi({ passwordSignIn: false, singleSignOnAvailable: false });
    await settleSignInMethods(di, undefined);
    expect(listSignInProviders).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('fails boot when Better Auth never finishes initialising, so the restart lands in the degraded path', async () => {
    vi.useFakeTimers();
    const { di } = makeDi({
      passwordSignIn: true,
      singleSignOnAvailable: true,
      authReady: new Promise(() => undefined),
    });
    const settled = settleSignInMethods(di, undefined);
    const outcome = expect(settled).rejects.toThrow(/did not initialise in time/);
    await vi.advanceTimersByTimeAsync(AUTH_INIT_TIMEOUT_MS);
    await outcome;
  });
});

describe('watchSingleSignOnRecovery', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('watches nothing when single sign-on is off or already working', () => {
    expect(
      watchSingleSignOnRecovery(
        makeDi({
          passwordSignIn: true,
          singleSignOnConfigured: false,
          singleSignOnAvailable: false,
        }).di,
        vi.fn(),
      ),
    ).toBeNull();
    expect(
      watchSingleSignOnRecovery(
        makeDi({ passwordSignIn: true, singleSignOnAvailable: true }).di,
        vi.fn(),
      ),
    ).toBeNull();
  });

  it('restarts once when the provider comes back, and not while it stays down', async () => {
    vi.useFakeTimers();
    const { di, record, setAvailable } = makeDi({
      passwordSignIn: true,
      singleSignOnAvailable: false,
    });
    const restart = vi.fn();
    checkDiscovery.mockResolvedValue({ ok: false, reason: 'unreachable' });
    const stop = watchSingleSignOnRecovery(di, restart);
    await vi.advanceTimersByTimeAsync(SINGLE_SIGN_ON_REPROBE_MS);
    expect(checkDiscovery).toHaveBeenCalledWith(ISSUER);
    expect(restart).not.toHaveBeenCalled();

    checkDiscovery.mockResolvedValue({ ok: true, discoveryUrl: 'x' });
    await vi.advanceTimersByTimeAsync(SINGLE_SIGN_ON_REPROBE_MS * 3);
    expect(restart).toHaveBeenCalledOnce();
    expect(setAvailable).toHaveBeenCalledWith(1);
    expect(eventsOf(record)).toEqual(['single-sign-on-recovered']);
    stop?.();
  });

  it('does not restart when shutdown arrives while a probe is still waiting on the provider', async () => {
    vi.useFakeTimers();
    const { di, record } = makeDi({ passwordSignIn: true, singleSignOnAvailable: false });
    const restart = vi.fn();
    let answer: (value: unknown) => void = () => undefined;
    checkDiscovery.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const stop = watchSingleSignOnRecovery(di, restart);
    await vi.advanceTimersByTimeAsync(SINGLE_SIGN_ON_REPROBE_MS);
    expect(checkDiscovery).toHaveBeenCalledOnce();
    stop?.();
    answer({ ok: true, discoveryUrl: 'x' });
    await vi.advanceTimersByTimeAsync(0);
    expect(restart).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('stops probing on shutdown', async () => {
    vi.useFakeTimers();
    const { di } = makeDi({ passwordSignIn: true, singleSignOnAvailable: false });
    const restart = vi.fn();
    checkDiscovery.mockResolvedValue({ ok: true, discoveryUrl: 'x' });
    watchSingleSignOnRecovery(di, restart)?.();
    await vi.advanceTimersByTimeAsync(SINGLE_SIGN_ON_REPROBE_MS * 2);
    expect(checkDiscovery).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });
});
