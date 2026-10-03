// Pins the MCP resource-identifier rules in the api env schema.
//
// The MCP suites all build their `Env` object by hand, so nothing there reaches the schema: every rule below is what the operator's own boot actually applies, and without this file each one could be deleted with the suite still green.
//
// Each rule is load-bearing for a different reason. The scheme rule keeps the OAuth issuer, the JWKS document and every authorization endpoint off plaintext on a host that stores Binance API keys unencrypted. The trailing-slash trim exists because the audience check is an exact string compare. The cross-field requirement is what turns "MCP_ENABLED with no resource" into a named boot failure rather than tokens bound to a guessed base URL and an unexplained 401. The LIVE_DEMO exclusion is what makes the documented kill switch true: without it the demo box still publishes the discovery documents and the whole OAuth authorization server, and only the per-request 403 on `/api/mcp` refuses.

import { describe, expect, it } from 'vitest';

import { loadEnv } from '../src/env.js';

/** The minimum a parse needs to succeed, so the MCP fields are the only thing under test. */
const MINIMUM = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  AUTH_SECRET: 'x'.repeat(32),
  WEB_ORIGIN: 'http://localhost:5173',
} satisfies NodeJS.ProcessEnv;

const withMcp = (resource?: string): NodeJS.ProcessEnv => ({
  ...MINIMUM,
  MCP_ENABLED: 'true',
  ...(resource === undefined ? {} : { MCP_RESOURCE_URL: resource }),
});

describe('MCP_RESOURCE_URL is required once MCP_ENABLED is on', () => {
  it('fails boot, naming the missing key, when the flag is on without a resource', () => {
    // Matching the key and the reason, not just "it threw": the schema has other cross-field refines, so a bare throw could come from an unrelated rule.
    expect(() => loadEnv(withMcp())).toThrow(
      /MCP_RESOURCE_URL: MCP_RESOURCE_URL is required when MCP_ENABLED is true/,
    );
  });

  it('stays optional while the flag is off', () => {
    // The discriminating half: a schema that simply made the field mandatory would satisfy the assertion above and break every non-MCP deployment.
    expect(loadEnv(MINIMUM).MCP_RESOURCE_URL).toBeUndefined();
  });
});

describe('MCP_RESOURCE_URL trailing slashes', () => {
  it.each([
    ['https://bot.example.com/api/mcp/', 'https://bot.example.com/api/mcp'],
    ['https://bot.example.com/api/mcp///', 'https://bot.example.com/api/mcp'],
    ['  https://bot.example.com/api/mcp/  ', 'https://bot.example.com/api/mcp'],
  ])('normalises %s to %s', (raw, expected) => {
    expect(loadEnv(withMcp(raw)).MCP_RESOURCE_URL).toBe(expected);
  });

  it('leaves a value that already has no trailing slash byte-identical', () => {
    // A "normaliser" that rewrote the path some other way would still pass the cases above; the audience check is an exact string compare, so identity on the already-canonical form is half of what makes the trim safe.
    expect(loadEnv(withMcp('https://bot.example.com/api/mcp')).MCP_RESOURCE_URL).toBe(
      'https://bot.example.com/api/mcp',
    );
  });
});

describe('MCP_RESOURCE_URL transport', () => {
  it.each([
    'https://bot.example.com/api/mcp',
    'http://127.0.0.1:3000/api/mcp',
    'http://127.1.2.3:3000/api/mcp',
    'http://localhost:3000/api/mcp',
    'http://[::1]:3000/api/mcp',
  ])('accepts %s', (resource) => {
    expect(loadEnv(withMcp(resource)).MCP_RESOURCE_URL).toBe(resource);
  });

  it.each([
    'http://bot.example.com/api/mcp',
    'http://192.168.1.10:3000/api/mcp',
    'http://127.0.0.1.example.com/api/mcp',
    'ftp://bot.example.com/api/mcp',
  ])('refuses %s', (resource) => {
    expect(() => loadEnv(withMcp(resource))).toThrow(/MCP_RESOURCE_URL: .*loopback/);
  });
});

describe('MCP_RESOURCE_URL identifier shape', () => {
  it.each([
    'https://bot.example.com/api/mcp?tenant=1',
    'https://bot.example.com/api/mcp#frag',
    'https://operator:hunter2@bot.example.com/api/mcp',
    'https://operator@bot.example.com/api/mcp',
    // The password-only form: the WHATWG parser accepts an empty username, so this parses to `username === ''` with `password === 'hunter2'` and is the only case the `url.password` operand of the predicate decides. Without it that operand is dominated by the username check and could be deleted with the rest of this file green, while the credential rode into the protected-resource metadata this app serves unauthenticated callers.
    'https://:hunter2@bot.example.com/api/mcp',
  ])('refuses %s', (resource) => {
    expect(() => loadEnv(withMcp(resource))).toThrow(
      /MCP_RESOURCE_URL: MCP_RESOURCE_URL must carry no query string, fragment or embedded credentials/,
    );
  });
});

describe('MCP_ENABLED and LIVE_DEMO are mutually exclusive at boot', () => {
  const RESOURCE = 'https://bot.example.com/api/mcp';

  it('refuses the combination, naming both flags and the reason', () => {
    expect(() =>
      loadEnv({ ...MINIMUM, LIVE_DEMO: 'true', MCP_ENABLED: 'true', MCP_RESOURCE_URL: RESOURCE }),
    ).toThrow(/MCP_ENABLED: MCP_ENABLED and LIVE_DEMO cannot both be true/);
  });

  it.each([
    ['MCP_ENABLED alone', { MCP_ENABLED: 'true', MCP_RESOURCE_URL: RESOURCE }, true, false],
    ['LIVE_DEMO alone', { LIVE_DEMO: 'true' }, false, true],
  ])('still boots with %s', (_label, overrides, expectedMcp, expectedDemo) => {
    // The discriminating half: a rule that refused either flag on its own would satisfy the assertion above while breaking both supported deployments.
    const env = loadEnv({ ...MINIMUM, ...overrides });
    expect(env.MCP_ENABLED).toBe(expectedMcp);
    expect(env.LIVE_DEMO).toBe(expectedDemo);
  });
});
