import { describe, expect, it } from 'vitest';
import {
  ProfileNotifyEvents,
  ProfileNotifyEventCategory,
  DEFAULT_PROFILE_NOTIFY_EVENTS,
  PROFILE_NOTIFY_EVENT_CATALOG,
  notifyEventMeta,
  OpsNotifyConfig,
  DEFAULT_OPS_NOTIFY_CONFIG,
  AccountNotifyEventCategory,
  ACCOUNT_NOTIFY_EVENT_CATALOG,
  accountNotifyEventMeta,
} from '../src/notify-events.js';

describe('ProfileNotifyEvents', () => {
  it('defaults every category to on, except the chatty order-filled category', () => {
    expect(ProfileNotifyEvents.parse({})).toEqual({
      'daily-loss-halt': true,
      'edge-decay-warning': true,
      discovery: true,
      'discovery-health': true,
      alive: true,
      'backtest-complete': true,
      // Off by default: an active grid fills often, so a fresh profile stays quiet.
      'order-filled': false,
      // ON by default: an order the bot could not place is usually the protective
      // stop, so the position may be sitting unguarded.
      'order-failed': true,
      'override-unresolved': true,
    });
    expect(DEFAULT_PROFILE_NOTIFY_EVENTS).toEqual(ProfileNotifyEvents.parse({}));
  });

  it('fills unspecified categories from defaults on a partial map', () => {
    expect(ProfileNotifyEvents.parse({ alive: false })).toMatchObject({
      alive: false,
      'daily-loss-halt': true,
      discovery: true,
    });
  });
});

describe('PROFILE_NOTIFY_EVENT_CATALOG', () => {
  it('has one entry per category, each looked up by notifyEventMeta', () => {
    for (const category of ProfileNotifyEventCategory.options) {
      const meta = notifyEventMeta(category);
      expect(meta?.category).toBe(category);
      expect(meta?.label.length).toBeGreaterThan(0);
    }
    expect(PROFILE_NOTIFY_EVENT_CATALOG).toHaveLength(ProfileNotifyEventCategory.options.length);
  });

  it('describes discovery-health in plain operator language, not developer jargon', () => {
    const meta = notifyEventMeta('discovery-health');
    // The operator is a solo trader, not an engineer: "wedged" is dev-speak
    // (CLAUDE.md invariant #3 — plain language, no assumed dev knowledge).
    expect(meta?.description.toLowerCase()).not.toContain('wedged');
    // Still carries the failure's consequence: new symbols stop rotating in.
    expect(meta?.description.toLowerCase()).toContain('rotate');
  });

  it('keeps the discovery-health label distinct from the discovery-changes label', () => {
    expect(notifyEventMeta('discovery')?.label).not.toBe(
      notifyEventMeta('discovery-health')?.label,
    );
  });
});

describe('OpsNotifyConfig', () => {
  it('defaults every account ops category to on, with a catalog entry each', () => {
    // orphan-order defaults ON despite being potentially chatty: an untracked
    // order is money the bot is not managing.
    expect(OpsNotifyConfig.parse({})).toEqual({
      'job-failed': true,
      'dust-transfer': true,
      'orphan-order': true,
    });
    expect(DEFAULT_OPS_NOTIFY_CONFIG).toEqual(OpsNotifyConfig.parse({}));
    for (const category of AccountNotifyEventCategory.options) {
      expect(accountNotifyEventMeta(category)?.category).toBe(category);
    }
    expect(ACCOUNT_NOTIFY_EVENT_CATALOG).toHaveLength(AccountNotifyEventCategory.options.length);
  });
});
