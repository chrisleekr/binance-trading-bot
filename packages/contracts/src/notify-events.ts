import { z } from 'zod';

/**
 * Profile-scoped notification event categories. Each names a kind of event the
 * worker can raise for one profile; the operator subscribes per category so a
 * capital-threatening halt can alert while a chatty digest stays muted. Account-
 * scoped ops events (a dead-lettered job, the worker going dark) are not here —
 * they are not tied to one profile and live in a separate ops config.
 */
export const ProfileNotifyEventCategory = z.enum([
  'daily-loss-halt',
  'edge-decay-warning',
  'discovery',
  'discovery-health',
  'alive',
  'backtest-complete',
  'order-filled',
  'order-failed',
  'override-unresolved',
]);
export type ProfileNotifyEventCategory = z.infer<typeof ProfileNotifyEventCategory>;

/**
 * Per-category subscription map, stored as the `profiles.notify_events` jsonb
 * column. Every category defaults to `true`, so a profile (or fixture) predating
 * the column keeps today's behaviour — every event still fires — until the
 * operator mutes one. A stored partial fills the rest from these defaults, so a
 * map that only pins `{'alive': false}` leaves the others on.
 */
export const ProfileNotifyEvents = z.object({
  'daily-loss-halt': z.boolean().default(true),
  'edge-decay-warning': z.boolean().default(true),
  discovery: z.boolean().default(true),
  // Default ON: a wedged or breadth-blocked discovery scan means the auto-set
  // silently stops rotating. That is a failure the operator must hear about,
  // distinct from the (mutable) rotation chatter of the `discovery` category.
  'discovery-health': z.boolean().default(true),
  alive: z.boolean().default(true),
  'backtest-complete': z.boolean().default(true),
  // Default OFF: the highest-frequency category. An active grid fills several
  // times a day, so a fresh profile stays quiet until the operator opts in.
  'order-filled': z.boolean().default(false),
  // Default ON: an order the bot could not place (or could not cancel, or would
  // not be allowed to place) is the bot failing to do the one thing it exists to
  // do, and it is usually the protective stop. The operator must hear about it.
  'order-failed': z.boolean().default(true),
  'override-unresolved': z.boolean().default(true),
});
export type ProfileNotifyEvents = z.infer<typeof ProfileNotifyEvents>;

/** The effective subscription map when a profile has not customised one (column is null). */
export const DEFAULT_PROFILE_NOTIFY_EVENTS: ProfileNotifyEvents = ProfileNotifyEvents.parse({});

/** UI-facing description of one event category: how to label it and how loud it is. */
export interface NotifyEventMeta {
  readonly category: ProfileNotifyEventCategory;
  readonly label: string;
  readonly description: string;
  /** Severity the worker stamps on the outgoing payload for this category. */
  readonly severity: 'info' | 'warn' | 'error';
}

/**
 * Single source of truth for how each profile event is labelled and how severe
 * it is. The worker reads `severity` when it builds the notify payload; the web
 * settings panel reads `label`/`description` to render the toggles. Keeping both
 * here stops the two surfaces drifting.
 */
export const PROFILE_NOTIFY_EVENT_CATALOG: readonly NotifyEventMeta[] = [
  {
    category: 'daily-loss-halt',
    label: 'Daily loss limit hit',
    description:
      "When the day's losses reach your limit and the bot pauses new buys until the next day.",
    severity: 'warn',
  },
  {
    category: 'edge-decay-warning',
    label: 'Edge decay warning',
    description:
      'When live results fall below your pinned backtest baseline — a heads-up; the bot does NOT pause buys.',
    severity: 'warn',
  },
  {
    category: 'discovery',
    label: 'Discovery changes',
    description: 'When auto-discovery starts or stops trading a symbol.',
    severity: 'info',
  },
  {
    category: 'discovery-health',
    label: 'Discovery not working',
    description:
      'When auto-discovery looks stuck — it has stopped checking the market, or has spent a while blocking every new symbol from being added. Nothing new will rotate in until it recovers.',
    severity: 'warn',
  },
  {
    category: 'alive',
    label: 'Periodic summary',
    description: 'A recurring digest of the profile’s holdings and balances.',
    severity: 'info',
  },
  {
    category: 'backtest-complete',
    label: 'Backtest finished',
    description: 'When a backtest you started finishes, with its headline result.',
    severity: 'info',
  },
  {
    category: 'order-filled',
    label: 'Order filled',
    description:
      "When one of this profile's orders fills, with the side, quantity, and price. Off by default — an active grid fills often.",
    severity: 'info',
  },
  {
    category: 'order-failed',
    label: 'Order could not be placed',
    description:
      'When the exchange refused an order, or would refuse the protective stop-loss the bot wants to place, so it never sent it. Either way the position may be unguarded — worth a look.',
    severity: 'error',
  },
  {
    category: 'override-unresolved',
    label: 'Manual action may not have run',
    description:
      'When an action you triggered by hand hit a network or exchange fault and the bot cannot tell whether it went through. Check the exchange.',
    severity: 'error',
  },
];

/** Look up a category's metadata; undefined for an unknown category string. */
export const notifyEventMeta = (
  category: ProfileNotifyEventCategory,
): NotifyEventMeta | undefined => PROFILE_NOTIFY_EVENT_CATALOG.find((m) => m.category === category);

/**
 * Account-scoped operational event categories. Unlike the profile events above,
 * these are not tied to one profile — a dead-lettered background job fails the
 * whole worker, not a single profile. They fan out to the union of every
 * configured notifier and are gated by the account-global ops config.
 */
export const AccountNotifyEventCategory = z.enum(['job-failed', 'dust-transfer', 'orphan-order']);
export type AccountNotifyEventCategory = z.infer<typeof AccountNotifyEventCategory>;

/**
 * Account-global subscription map for ops events, stored as the singleton
 * `ops_notify_config.events` jsonb. Every category defaults to `true` so the
 * operator hears operational failures until they mute one; a stored partial
 * fills the rest from these defaults.
 */
export const OpsNotifyConfig = z.object({
  'job-failed': z.boolean().default(true),
  'dust-transfer': z.boolean().default(true),
  // Default ON despite being potentially chatty: an untracked order is money the
  // bot is not managing. The two-tick confirmation upstream already filters the
  // transient false positives, so what survives to here is worth hearing.
  'orphan-order': z.boolean().default(true),
});
export type OpsNotifyConfig = z.infer<typeof OpsNotifyConfig>;

/** The effective ops config when none has been customised (column is empty). */
export const DEFAULT_OPS_NOTIFY_CONFIG: OpsNotifyConfig = OpsNotifyConfig.parse({});

/** UI-facing description of one account ops event category. */
export interface AccountNotifyEventMeta {
  readonly category: AccountNotifyEventCategory;
  readonly label: string;
  readonly description: string;
  readonly severity: 'info' | 'warn' | 'error';
}

/** Single source of truth for the account ops event labels + severities. */
export const ACCOUNT_NOTIFY_EVENT_CATALOG: readonly AccountNotifyEventMeta[] = [
  {
    category: 'job-failed',
    label: 'Background job failed',
    description:
      'When a background job (a trade tick, a backup, an archive) fails and is dead-lettered after its retries.',
    severity: 'error',
  },
  {
    category: 'dust-transfer',
    label: 'Dust converted to BNB',
    description:
      'When leftover small balances ("dust") in your Binance wallet are converted to BNB — a money-path action, so you always hear about it.',
    severity: 'info',
  },
  {
    category: 'orphan-order',
    label: 'Untracked order on Binance',
    description:
      'When an order is open on Binance that the bot is not managing — it will not be sold, stopped out, or repriced until you adopt or cancel it.',
    severity: 'warn',
  },
];

/** Look up an account category's metadata; undefined for an unknown category. */
export const accountNotifyEventMeta = (
  category: AccountNotifyEventCategory,
): AccountNotifyEventMeta | undefined =>
  ACCOUNT_NOTIFY_EVENT_CATALOG.find((m) => m.category === category);
