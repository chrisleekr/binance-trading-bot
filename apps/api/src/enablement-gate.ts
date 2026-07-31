import { EnablementPolicy } from '@app/contracts';
import type { StrategyRegistry } from '@app/strategy-core';
import { HttpError } from 'middleware/error.js';

/** Minimal registry surface the gate needs — satisfied by both the worker's full
 * registry and the API's read-only `ApiStrategyRegistry`. */
interface RegistryLike {
  describeForProfile: StrategyRegistry['describeForProfile'];
}

export interface EnablementGateArgs {
  readonly strategies: RegistryLike;
  /** The mode the profile WILL run in once enabled. */
  readonly binanceMode: string;
  /** Raw `enablement_policy` column value (nullable → defaults). */
  readonly enablementPolicy: unknown;
  readonly strategyName: string;
  readonly strategyVersion: string;
}

/**
 * Guard enabling a profile in `live` mode. Backtest quality NEVER blocks going
 * live — the live-gate is advisory (surfaced on the dashboard card), and the only
 * optional enforcement is the worker's runtime pause on new buys. The one thing
 * still refused here is a structurally unrunnable profile: an unknown strategy
 * would enable and then go dark at tick time, so "cannot run" is rejected up front.
 */
export function assertLiveEnablementAllowed(args: EnablementGateArgs): void {
  if (args.binanceMode !== 'live') return; // gate guards real money only
  const policy = EnablementPolicy.parse(args.enablementPolicy ?? {});
  if (!policy.enabled) return; // operator turned the gate off for this profile

  const resolved = args.strategies.describeForProfile(args.strategyName, args.strategyVersion);
  if (resolved.status === 'unknown') {
    throw new HttpError('VALIDATION_FAILED', 'strategy not registered for profile');
  }
}
