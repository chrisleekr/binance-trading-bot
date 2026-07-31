import type { Strategy, StrategyEventMap } from './contract.js';

export type AnyStrategy = Strategy<
  unknown,
  unknown,
  Readonly<Record<string, unknown>>,
  StrategyEventMap
>;

/**
 * Outcome of resolving a STORED profile's `(name, storedVersion)` against the
 * live plugin set. `migratable` still hands back the live plugin — a drifted
 * version is the plugin that actually runs in `tick()`, not an unknown
 * strategy. Splitting drift from a genuine miss keeps the no-silent-failure
 * invariant: a caller can gate on the live plugin while still telling the two
 * apart, instead of conflating both into a `null`.
 */
export type ResolvedStrategy =
  | { readonly status: 'current'; readonly strategy: AnyStrategy }
  | {
      readonly status: 'migratable';
      readonly strategy: AnyStrategy;
      readonly liveVersion: string;
      readonly storedVersion: string;
    }
  | { readonly status: 'unknown'; readonly name: string };

export interface StrategyRegistry {
  register(strategy: AnyStrategy): void;
  list(): readonly AnyStrategy[];
  /** Latest-registered plugin by name — what `tick()` runs. The single
   *  name-keyed lookup both apps share. Version never gates the hit. */
  get(name: string): AnyStrategy | undefined;
  /**
   * Resolve a STORED `(name, storedVersion)` for capability/schema gating.
   * Returns the live plugin even when `storedVersion` drifts; version is
   * diagnostic, never a pass/fail key.
   */
  describeForProfile(name: string, storedVersion: string): ResolvedStrategy;
}

export const createRegistry = (): StrategyRegistry => {
  const registered = new Map<string, AnyStrategy>();
  return {
    register(strategy) {
      if (registered.has(strategy.name)) {
        throw new Error(`duplicate strategy: ${strategy.name}`);
      }
      registered.set(strategy.name, strategy);
    },
    list: () => Array.from(registered.values()),
    get: (name) => registered.get(name),
    describeForProfile: (name, storedVersion) => {
      const strategy = registered.get(name);
      if (!strategy) return { status: 'unknown', name };
      if (strategy.version === storedVersion) return { status: 'current', strategy };
      return { status: 'migratable', strategy, liveVersion: strategy.version, storedVersion };
    },
  };
};
