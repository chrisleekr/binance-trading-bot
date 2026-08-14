// "Which config setting armed this blocker?" — resolved off the strategy's own
// declared attribution map, never a hardcoded per-strategy table here.
//
// Moved out of the web because two surfaces now ask the same question of the
// same map: the backtest breakdown, which explains why a simulated tick did
// nothing, and the live profile diagnosis, which explains why a real one did.
// Both must name the same field for the same reason code, and the only way to
// guarantee that is one implementation.

import { tokenizePath } from './backtest.js';
import type { StrategyDescriptor } from './strategies.js';

/**
 * The reason-code → config-setting attribution map the strategy declares (on its
 * public descriptor), resolved at runtime from `GET /strategies`. Nothing here
 * knows any strategy's codes (core invariant 1): it names a blocker's lever off
 * whatever the active strategy provides.
 */
export type ReasonAttributionMap = NonNullable<StrategyDescriptor['reasonAttribution']>;

const getPath = (obj: unknown, path: readonly string[]): unknown =>
  path.reduce<unknown>(
    (acc, k) =>
      acc !== null && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined,
    obj,
  );

/** True when a config value actively arms a gate (not unset / off / zero). */
const isArmedValue = (v: unknown): boolean => {
  if (v === true) return true;
  if (typeof v === 'string') return v !== '' && v !== 'off' && v !== '0';
  if (typeof v === 'object' && v !== null) return Object.keys(v).length > 0;
  return false;
};

/** Format a config value for display: booleans as on/off, empty as "off". */
const displayConfigValue = (v: unknown): string => {
  if (v === true) return 'on';
  if (v === false || v === '' || v === null || v === undefined) return 'off';
  if (typeof v === 'object') return 'set';
  return String(v);
};

export interface BlockerAttribution {
  /** Plain-language setting name, or null when the code names no lever. */
  readonly setting: string | null;
  /** The dotted config path that armed it, or null when there is no editable lever. */
  readonly path: string | null;
  /** Current value of `path`, formatted for display; null when no path. */
  readonly value: string | null;
  /** Extra context (the strategy's note for this code), or null. */
  readonly detail: string | null;
}

/**
 * Resolve "which config setting armed this blocker" off the PASSED attribution
 * map (the strategy's own declaration), reading the config so the caller can
 * name the exact field and its current value. Picks the first armed path; a
 * path-less entry falls back to its note (a market read / exchange minimum).
 * Returns null when the code is absent from the map OR the entry names no lever
 * at all (a pure gloss/kind entry: legible in the funnel, nothing to attribute).
 */
export function attributeBlocker(
  code: string,
  attributionMap: ReasonAttributionMap,
  config: Record<string, unknown>,
): BlockerAttribution | null {
  const attr = attributionMap[code];
  if (!attr) return null;
  const setting = attr.setting ?? null;
  const detail = attr.note ?? null;
  const paths = attr.paths ?? [];
  // A pure gloss/kind entry (no setting, no paths, no note) has no lever line.
  if (setting === null && detail === null && paths.length === 0) return null;
  if (paths.length === 0) {
    return { setting, path: null, value: null, detail };
  }
  const armed = paths.find((p) => isArmedValue(getPath(config, tokenizePath(p))));
  const path = armed ?? paths[0] ?? null;
  return {
    setting,
    path,
    value: path === null ? null : displayConfigValue(getPath(config, tokenizePath(path))),
    detail,
  };
}
