import { z, ZodObject, ZodType } from 'zod';

/**
 * Thrown by {@link createNotifyRegistry}'s `register()` when a provider's
 * manifest fails structural validation. Surfacing the failure at registration
 * time (single call, single boot) is the whole point: without it, a malformed
 * provider only blows up when the first notify fires — usually in production,
 * because per-provider unit tests rarely exercise the registry path. The
 * thrown message names the offending field so the operator can find the
 * provider that needs the fix.
 */
export class NotifyProviderContractError extends Error {
  constructor(
    public readonly providerName: string,
    public readonly field: string,
    reason: string,
  ) {
    super(`notify provider "${providerName}": ${field} ${reason}`);
    this.name = 'NotifyProviderContractError';
  }
}

type AssertNonEmptyString = (
  name: string,
  field: string,
  value: unknown,
) => asserts value is string;

const assertNonEmptyString: AssertNonEmptyString = (name, field, value) => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new NotifyProviderContractError(name, field, 'must be a non-empty string');
  }
};

/**
 * Validate the structural contract every provider must satisfy. Called
 * exactly once per provider, inside `register()`. Defended fields:
 *   - identity (name / version / displayName) — string surfaces the SPA
 *     and registry uniqueness key depend on.
 *   - `secretFields` — must be `string[]`; downstream the SPA marks these
 *     write-once and the api's `describeAll()` projects them verbatim.
 *   - `configSchema` — must be a {@link ZodObject}; `describeAll()` serialises
 *     it to draft-07 JSON Schema via `z.toJSONSchema`, which requires an
 *     object root (a non-object schema would serialise to garbage the SPA
 *     can't render).
 *   - `send` — must be a function. Catches a manifest assembled from
 *     untrusted JSON (e.g. dynamic require) where the body is missing.
 */
type AssertProviderManifest = (provider: unknown) => asserts provider is AnyNotifyProvider;

const assertProviderManifest: AssertProviderManifest = (provider) => {
  if (provider === null || typeof provider !== 'object') {
    throw new NotifyProviderContractError('<unknown>', '<root>', 'must be an object');
  }
  const p = provider as Record<string, unknown>;
  const name = typeof p['name'] === 'string' ? p['name'] : '<unknown>';
  assertNonEmptyString(name, 'name', p['name']);
  assertNonEmptyString(name, 'version', p['version']);
  assertNonEmptyString(name, 'displayName', p['displayName']);
  if (
    !Array.isArray(p['secretFields']) ||
    !(p['secretFields'] as unknown[]).every((s) => typeof s === 'string')
  ) {
    throw new NotifyProviderContractError(name, 'secretFields', 'must be a readonly string[]');
  }
  // `secretFields` are top-level configSchema keys; the SPA's AutoForm
  // binds them to flat form inputs and the api's describeAll() serialises
  // them as-is. A dot-path would silently slip through here but the SPA
  // could never bind it — reject early to pin the contract.
  for (const sf of p['secretFields'] as readonly string[]) {
    if (sf.includes('.')) {
      throw new NotifyProviderContractError(
        name,
        'secretFields',
        `entry "${sf}" must be a flat top-level configSchema key (dot-paths are not supported)`,
      );
    }
  }
  if (!(p['configSchema'] instanceof ZodObject)) {
    throw new NotifyProviderContractError(
      name,
      'configSchema',
      'must be a ZodObject (describeAll() serialises it to draft-07 JSON Schema)',
    );
  }
  if (typeof p['send'] !== 'function') {
    throw new NotifyProviderContractError(name, 'send', 'must be a function');
  }
};

/** Three-level severity each provider maps to its own visual prefix. */
export type NotifySeverity = 'info' | 'warn' | 'error';

/**
 * One display-ready label/value pair. Both sides are already-formatted strings:
 * the worker owns `Decimal`, units, and precision, so the pure providers never
 * do money math and only escape for their own syntax. A field carrying "98% of
 * limit" or "12.34 USDT" arrives here pre-rendered.
 */
export interface NotifyField {
  readonly label: string;
  readonly value: string;
}

/**
 * The structured message every provider receives and renders in its own syntax.
 * Replaces the old free-form `payload: unknown`: the worker builds this once
 * (resolving the profile name, formatting values) and each provider maps it to
 * Slack mrkdwn / Telegram HTML / a webhook JSON body, escaping dynamic content
 * at its own boundary. `topic` stays the machine id (webhook routing, gap
 * traces); `title` is the human headline shown to the operator.
 */
export interface NotifyMessage {
  readonly severity: NotifySeverity;
  readonly topic: string;
  readonly title: string;
  /** Resolved profile name (never the UUID); absent for account-wide events. */
  readonly profile?: string;
  /** The symbol the event is about, when it concerns exactly one. */
  readonly symbol?: string;
  /** A human sentence: what happened, what it means, what to do. */
  readonly body?: string;
  /** Extra display-ready detail lines. */
  readonly fields?: readonly NotifyField[];
  /** Absolute URL the operator can tap through to; omitted when no base URL is configured. */
  readonly link?: string;
}

/**
 * The single source of truth for what a notifier looks like. `secretFields`
 * lets the SPA mark inputs as write-once; `version` lets the api show a stale
 * config warning when a provider's schema bumps without forcing every config
 * to re-validate. `Config` is generic so each provider keeps its own Zod
 * schema and the registry never widens to `any`.
 */
export interface NotifyProvider<Config = unknown> {
  readonly name: string;
  readonly version: string;
  readonly displayName: string;
  readonly secretFields: readonly string[];
  /**
   * Must be a {@link ZodObject}, not just any `ZodType`: `describeAll()`
   * serialises this to draft-07 JSON Schema for the SPA, which requires an
   * object root. `ZodType<Config>` keeps the `Config` linkage; `& ZodObject`
   * pins the object-rootedness. The runtime validator inside `register()`
   * enforces the same invariant for manifests assembled outside the type
   * system.
   */
  readonly configSchema: ZodType<Config> & ZodObject;
  send(input: { readonly config: Config; readonly message: NotifyMessage }): Promise<void>;
}

/** Erased-config alias the registry stores so it can hold mixed providers. */
export type AnyNotifyProvider = NotifyProvider<unknown>;

/**
 * Metadata projection of a {@link NotifyProvider} the api hands the SPA so it
 * can render the auto-form. `send()` is intentionally absent — the api never
 * calls it; that is a worker-only concern.
 */
export interface NotifyProviderDescriptor {
  readonly name: string;
  readonly version: string;
  readonly displayName: string;
  readonly configSchema: unknown;
  readonly secretFields: readonly string[];
}

/**
 * The registry the worker calls to resolve providers and the api projects via
 * `describeAll()` for the SPA. Splits read (`list`/`get`/`describeAll`) from
 * write (`register`) so production code can pass a read-only narrowing where
 * it does not own the registration phase.
 */
export interface NotifyProviderRegistry {
  register(provider: AnyNotifyProvider): void;
  list(): readonly AnyNotifyProvider[];
  get(name: string): AnyNotifyProvider | undefined;
  describeAll(): readonly NotifyProviderDescriptor[];
}

/**
 * Boots a fresh registry. A `Map` keyed by `name` enforces uniqueness at
 * registration; insertion order is preserved so api/worker can rely on the
 * same describe order without sorting.
 */
export const createNotifyRegistry = (): NotifyProviderRegistry => {
  const registered = new Map<string, AnyNotifyProvider>();
  return {
    register(provider) {
      assertProviderManifest(provider);
      if (registered.has(provider.name)) {
        throw new Error(`duplicate notify provider: ${provider.name}`);
      }
      registered.set(provider.name, provider);
    },
    list: () => Array.from(registered.values()),
    get: (name) => registered.get(name),
    describeAll: () =>
      Array.from(registered.values()).map((p) => ({
        name: p.name,
        version: p.version,
        displayName: p.displayName,
        // Serialise the provider's zod schema to draft-07 JSON Schema so the
        // SPA renders a typed AutoForm — a raw zod object is not meaningfully
        // JSON-serialisable. draft-07 matches the browser ajv validator;
        // `unrepresentable: 'any'` degrades a cross-field refinement to `{}`
        // rather than throwing. `io: 'input'` so a field with a zod
        // `.default()` is not marked required — the config form is an input
        // surface, and default-output mode marks every defaulted field
        // required. Input mode also drops `additionalProperties: false`; the
        // server re-validates on save, so an unknown key is still rejected.
        configSchema: z.toJSONSchema(p.configSchema, {
          target: 'draft-07',
          unrepresentable: 'any',
          io: 'input',
        }),
        secretFields: [...p.secretFields],
      })),
  };
};
