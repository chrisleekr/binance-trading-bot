import type { StrategyDescriptor, OperatorAction } from '@app/contracts';
import { toConfigJsonSchema } from '@app/contracts';
import type { AnyStrategy, ResolvedStrategy, StrategyRegistry } from '@app/strategy-core';

// The api consumes the core `AnyStrategy` directly — there is no parallel
// api-side plugin interface. A second interface plus a `toPlugin` cast meant
// every new contract field was a four-file lockstep edit and silently dropped
// anything the cast forgot (the `capabilities` drop that hid the momentum
// operator-action silent-failure). Reading `AnyStrategy` keeps the registry
// total: a new field on the contract flows here for free.
//
// The facade adds only the SPA serialisation (`describeAll`); lookup
// (`get`, `describeForProfile`) delegates to the shared core registry so the
// api and worker can never disagree on whether a strategy is registered. It
// is intentionally NOT keyed by `name@version`: keying on the stored version
// returned `null` for a profile whose strategy had since bumped, silently
// 422'ing operator controls on a live profile.
export interface ApiStrategyRegistry {
  list(): readonly AnyStrategy[];
  get(name: string): AnyStrategy | undefined;
  describeForProfile(name: string, storedVersion: string): ResolvedStrategy;
  describeAll(): StrategyDescriptor[];
}

export const createApiStrategyRegistry = (core: StrategyRegistry): ApiStrategyRegistry => {
  return {
    list: () => core.list(),
    get: (name) => core.get(name),
    describeForProfile: (name, storedVersion) => core.describeForProfile(name, storedVersion),
    describeAll: () =>
      core.list().map((s) => ({
        name: s.name,
        version: s.version,
        displayName: s.displayName,
        description: s.description,
        // Serialise the strategy's zod config schema to the JSON Schema the SPA
        // renders from. `toConfigJsonSchema` centralises the options (draft-07,
        // unrepresentable: 'any', io: 'input') so the api descriptor, the web
        // config panels, and the docs config-table generator can never diverge.
        configSchema: toConfigJsonSchema(s.configSchema),
        overrideConfigSchema: toConfigJsonSchema(s.overrideConfigSchema),
        defaultConfig: s.defaultConfig as Record<string, unknown>,
        // `capabilities.operatorActions` is loose `string[]` (mirroring
        // bundleProviders); the registry consistency test proves every token
        // is a real OPERATOR_ACTIONS member, so the cast to the closed type is
        // sound and lets the descriptor's `z.enum` field type check.
        operatorActions: [...s.capabilities.operatorActions] as OperatorAction[],
        // Plain string data — passed through verbatim, no JSON-Schema
        // conversion. Spread conditionally so the descriptor field stays
        // undefined for strategies that declare no attribution.
        ...(s.reasonAttribution
          ? { reasonAttribution: s.reasonAttribution as StrategyDescriptor['reasonAttribution'] }
          : {}),
      })),
  };
};
