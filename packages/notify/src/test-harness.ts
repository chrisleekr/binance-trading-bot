// Notify provider conformance harness.
//
// Every provider under `src/providers/*.ts` MUST be exercised through
// `runNotifyProviderConformance` from its sibling test file. The contract
// asserted here is the spec — drift between this harness and a provider
// surfaces as a failing test, not a runtime surprise on first send.
// `scripts/ci/notify-conformance-coverage.sh` is the lint-side gate that
// rejects a new provider without a sibling conformance-importing test.

import { describe, expect, it } from 'vitest';
import { z, ZodObject } from 'zod';
import { createNotifyRegistry, type AnyNotifyProvider, type NotifyMessage } from './contract.js';

export interface NotifyProviderConformanceFixtures<Config = unknown> {
  /** A config the provider's `configSchema` MUST accept. */
  readonly validConfig: Config;
  /**
   * Empty-config rejection. Defaults to `{}` — every current provider has at
   * least one required field, so the empty object falls through to a zod
   * error. Override only if a future provider has all-optional config (it
   * still needs SOME way to fail the schema so the test is meaningful).
   */
  readonly invalidConfig?: unknown;
  /**
   * Send-path fixture: the payload to forward and a transport double that
   * captures the call. Verifies that `send()` returns a Promise and runs
   * the transport at least once. Provider-specific assertions (URL, body
   * shape) stay in the provider's own test — this harness covers the
   * generic contract only.
   */
  readonly sendFixture: {
    readonly message: NotifyMessage;
    /** Builds a provider whose I/O is captured by the harness. */
    readonly buildProvider: (transport: { calls: unknown[] }) => AnyNotifyProvider;
  };
}

/**
 * Run the standard conformance suite against `provider` and its fixtures.
 * Adds one `describe` block per call so multiple providers in a single test
 * file (rare) stay distinguishable in the runner's output.
 */
export const runNotifyProviderConformance = <Config = unknown>(
  provider: AnyNotifyProvider,
  fixtures: NotifyProviderConformanceFixtures<Config>,
): void => {
  describe(`@app/notify conformance: ${provider.name}`, () => {
    it('manifest registers without throwing — contract is structurally valid', () => {
      const r = createNotifyRegistry();
      // register() runs the same NotifyProviderContractError path described
      // in src/contract.ts. A throw here is the spec violation.
      expect(() => r.register(provider)).not.toThrow();
    });

    it('configSchema is a ZodObject (describeAll() requires an object root)', () => {
      expect(provider.configSchema).toBeInstanceOf(ZodObject);
    });

    it('configSchema accepts the known-good fixture', () => {
      expect(() => provider.configSchema.parse(fixtures.validConfig)).not.toThrow();
    });

    it('configSchema rejects an invalid config', () => {
      const invalid = fixtures.invalidConfig ?? {};
      expect(provider.configSchema.safeParse(invalid).success).toBe(false);
    });

    it('secretFields are all flat top-level keys of the configSchema', () => {
      // The SPA marks these write-once on the matching input; a secret field
      // that doesn't exist on the (flat) schema means the SPA can never bind
      // it. Dot-paths are rejected by the registry validator and asserted
      // here so the spec is visible in the harness itself.
      const schemaKeys = Object.keys((provider.configSchema as z.ZodObject).shape);
      for (const f of provider.secretFields) {
        expect(f).not.toContain('.');
        expect(schemaKeys).toContain(f);
      }
    });

    it('send() forwards the payload through its transport and resolves', async () => {
      const transport = { calls: [] as unknown[] };
      const p = fixtures.sendFixture.buildProvider(transport);
      const result = p.send({
        config: fixtures.validConfig as never,
        message: fixtures.sendFixture.message,
      });
      // Contract: send returns a Promise. The harness awaits to surface any
      // throw or unhandled-rejection inside the provider.
      expect(result).toBeInstanceOf(Promise);
      await result;
      expect(transport.calls.length).toBeGreaterThan(0);
    });
  });
};
