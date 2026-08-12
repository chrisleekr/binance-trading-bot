// Daily "alive" balance digest.
//
// The `alive` cron fires at 09:00 and sends each active profile's
// operator a balance snapshot through every notifier configured for that
// profile. It is the bot's daily heartbeat — proof the worker is up and
// a record of what the account holds. It is gated on the profile's
// `notify_events` subscription for the `alive` category (default on), so an
// operator who only wants capital-safety alerts can mute the digest.

import { Decimal } from '@app/money';
import type { Logger } from 'pino';
import type { AccountId, ProfileId, UserId } from '@app/contracts';
import type { BinanceRestClient } from '@app/binance';
import type { NotifyMessage, NotifyProviderRegistry } from '@app/notify';
import { resolveNotifiersFromRows, type NotifierRowInput } from 'notifiers/lookup.js';
import { dispatchNotify } from 'notifiers/dispatch.js';
import type { ActiveProfile } from 'profile-manager/profile-manager.js';

export interface AliveDigestDeps {
  readonly logger: Logger;
  readonly resolveBinance: (
    operatorId: UserId,
    accountId: AccountId,
  ) => Promise<BinanceRestClient | null>;
  /** The profile's notifier rows; the worker wires this to `profileRepo(...).profileNotifiers.listForProfile`. */
  readonly listNotifiers: (
    operatorId: UserId,
    accountId: AccountId,
    profileId: ProfileId,
  ) => Promise<readonly NotifierRowInput[]>;
  /** Whether the profile is subscribed to the `alive` event (the worker wires this to `isProfileEventEnabled`). */
  readonly isEventEnabled: (
    operatorId: UserId,
    accountId: AccountId,
    profileId: ProfileId,
  ) => Promise<boolean>;
  /** Resolve the profile's display name for the digest header; the worker wires this to `profileRepo(...).profile.findById`. */
  readonly resolveProfileName: (
    operatorId: UserId,
    accountId: AccountId,
    profileId: ProfileId,
  ) => Promise<string | null>;
  readonly notifyRegistry: NotifyProviderRegistry;
  /** Public "Live demo" mode: suppresses the alive-digest dispatch. */
  readonly liveDemo?: boolean;
}

/** How many held assets the digest lists before collapsing the rest into "+N more". */
const HOLDINGS_CAP = 6;

/**
 * Build the per-profile digest closure. The returned function fetches one
 * profile's Binance balances and fans a digest out to its notifiers. It
 * is a no-op (logged) when the profile has no notifiers or no
 * credentials; a Binance failure propagates so the caller can count it —
 * `safeNotify` already swallows individual provider failures.
 */
export const createAliveDigest = (
  deps: AliveDigestDeps,
): ((profile: ActiveProfile) => Promise<void>) => {
  return async (profile: ActiveProfile) => {
    if (!(await deps.isEventEnabled(profile.operatorId, profile.accountId, profile.profileId))) {
      deps.logger.debug(
        { profileId: profile.profileId },
        'alive: digest muted by notify_events subscription, skipping',
      );
      return;
    }
    const resolved = resolveNotifiersFromRows(
      await deps.listNotifiers(profile.operatorId, profile.accountId, profile.profileId),
    );
    if (resolved.length === 0) {
      deps.logger.debug(
        { profileId: profile.profileId },
        'alive: no notifiers configured, skipping digest',
      );
      return;
    }
    const rest = await deps.resolveBinance(profile.operatorId, profile.accountId);
    if (!rest) {
      deps.logger.warn({ profileId: profile.profileId }, 'alive: no credentials, skipping digest');
      return;
    }
    const account = await rest.getAccount();
    // A live Binance account lists hundreds of zero-balance assets; the
    // digest only carries the assets the operator actually holds.
    const held = account.balances
      .map((b) => ({ asset: b.asset, total: new Decimal(b.free).plus(b.locked) }))
      .filter((b) => b.total.gt(0));
    const shown = held.slice(0, HOLDINGS_CAP).map((h) => `${h.total.toString()} ${h.asset}`);
    const more = held.length > HOLDINGS_CAP ? ` +${held.length - HOLDINGS_CAP} more` : '';
    const symbolCount = profile.symbols.length;
    const name = await deps.resolveProfileName(
      profile.operatorId,
      profile.accountId,
      profile.profileId,
    );
    const message: NotifyMessage = {
      severity: 'info',
      topic: 'alive',
      title: 'Periodic summary',
      ...(name ? { profile: name } : {}),
      body: `Running normally. ${symbolCount} ${symbolCount === 1 ? 'symbol' : 'symbols'} active.`,
      fields: [
        { label: 'Symbols', value: symbolCount > 0 ? profile.symbols.join(', ') : 'none' },
        { label: 'Holdings', value: shown.length > 0 ? shown.join(', ') + more : 'none' },
      ],
    };
    // Informational: an undelivered digest gets the dispatcher's warn log, not
    // a durable action_log row.
    await dispatchNotify(
      {
        registry: deps.notifyRegistry,
        logger: deps.logger,
        ...(deps.liveDemo ? { liveDemo: true } : {}),
      },
      resolved,
      message,
    );
    deps.logger.info(
      { profileId: profile.profileId, notifiers: resolved.length, assets: held.length },
      'alive: digest sent',
    );
  };
};
