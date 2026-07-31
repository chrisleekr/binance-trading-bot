// Negative-path tests for the runtime contract validator in
// createNotifyRegistry.register(). Each test asserts the registry rejects a
// specific malformation. Catching these at registration time (worker / api
// boot) is the whole point — a missed field today blows up on first send,
// which is usually in production.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createNotifyRegistry,
  NotifyProviderContractError,
  type AnyNotifyProvider,
} from '../src/contract.js';

const validBase = (): Record<string, unknown> => ({
  name: 'test',
  version: '1.0.0',
  displayName: 'Test',
  secretFields: [],
  configSchema: z.object({}),
  send: async () => undefined,
});

describe('createNotifyRegistry.register — contract validation', () => {
  it('accepts a fully-formed manifest', () => {
    const r = createNotifyRegistry();
    expect(() => r.register(validBase() as unknown as AnyNotifyProvider)).not.toThrow();
  });

  it.each([
    ['name', { ...validBase(), name: '' }, /name must be a non-empty string/],
    ['version', { ...validBase(), version: undefined }, /version must be a non-empty string/],
    ['displayName', { ...validBase(), displayName: 42 }, /displayName must be a non-empty string/],
    [
      'secretFields (not an array)',
      { ...validBase(), secretFields: 'webhookUrl' },
      /secretFields must be a readonly string\[\]/,
    ],
    [
      'secretFields (non-string entry)',
      { ...validBase(), secretFields: ['ok', 42] },
      /secretFields must be a readonly string\[\]/,
    ],
    [
      'secretFields (dot-path entry)',
      { ...validBase(), secretFields: ['connection.token'] },
      /flat top-level configSchema key \(dot-paths are not supported\)/,
    ],
    [
      'configSchema (not a ZodObject)',
      { ...validBase(), configSchema: z.string() },
      /configSchema must be a ZodObject/,
    ],
    [
      'send (not a function)',
      { ...validBase(), send: 'not-a-function' },
      /send must be a function/,
    ],
  ])('rejects a manifest with bad %s', (_label, bad, msgRe) => {
    const r = createNotifyRegistry();
    expect(() => r.register(bad as unknown as AnyNotifyProvider)).toThrow(msgRe);
  });

  it('throws a NotifyProviderContractError (typed) so callers can catch by class', () => {
    const r = createNotifyRegistry();
    try {
      r.register({ ...validBase(), name: '' } as unknown as AnyNotifyProvider);
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NotifyProviderContractError);
    }
  });

  it('rejects null / non-object manifests up-front', () => {
    const r = createNotifyRegistry();
    expect(() => r.register(null as unknown as AnyNotifyProvider)).toThrow(/must be an object/);
    expect(() => r.register('slack' as unknown as AnyNotifyProvider)).toThrow(/must be an object/);
  });
});
