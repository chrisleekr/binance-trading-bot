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

describe('sign-in method variables', () => {
  const SSO = {
    SINGLE_SIGN_ON_ENABLED: '1',
    SINGLE_SIGN_ON_ISSUER_URL: 'https://tenant.auth0.com/',
    SINGLE_SIGN_ON_CLIENT_ID: 'client',
    SINGLE_SIGN_ON_CLIENT_SECRET: 'secret',
    PUBLIC_BASE_URL: 'https://bot.example.com',
  };

  it('defaults to password sign-in only', () => {
    const env = loadEnv(MINIMUM);
    expect(env.PASSWORD_SIGN_IN_ENABLED).toBe(true);
    expect(env.SINGLE_SIGN_ON_ENABLED).toBe(false);
  });

  it('refuses a mistyped password flag instead of silently hiding the form', () => {
    expect(() => loadEnv({ ...MINIMUM, PASSWORD_SIGN_IN_ENABLED: 'yes' })).toThrow(
      /PASSWORD_SIGN_IN_ENABLED/,
    );
  });

  it('refuses a configuration with no way to sign in', () => {
    expect(() => loadEnv({ ...MINIMUM, PASSWORD_SIGN_IN_ENABLED: '0' })).toThrow(
      /At least one of PASSWORD_SIGN_IN_ENABLED or SINGLE_SIGN_ON_ENABLED/,
    );
    expect(
      loadEnv({ ...MINIMUM, ...SSO, PASSWORD_SIGN_IN_ENABLED: '0' }).PASSWORD_SIGN_IN_ENABLED,
    ).toBe(false);
  });

  it.each([
    'SINGLE_SIGN_ON_ISSUER_URL',
    'SINGLE_SIGN_ON_CLIENT_ID',
    'SINGLE_SIGN_ON_CLIENT_SECRET',
    'PUBLIC_BASE_URL',
  ])('requires %s when single sign-on is on, and treats an empty value as missing', (name) => {
    expect(() => loadEnv({ ...MINIMUM, ...SSO, [name]: undefined })).toThrow(
      /are required when SINGLE_SIGN_ON_ENABLED is true/,
    );
    expect(() => loadEnv({ ...MINIMUM, ...SSO, [name]: '' })).toThrow(
      /are required when SINGLE_SIGN_ON_ENABLED is true/,
    );
  });

  it('accepts empty optional values while single sign-on is off, as compose passes them', () => {
    const env = loadEnv({
      ...MINIMUM,
      SINGLE_SIGN_ON_ISSUER_URL: '',
      SINGLE_SIGN_ON_CLIENT_ID: '',
      SINGLE_SIGN_ON_CLIENT_SECRET: '',
      PUBLIC_BASE_URL: '',
    });
    expect(env.SINGLE_SIGN_ON_ISSUER_URL).toBeUndefined();
    expect(env.PUBLIC_BASE_URL).toBeUndefined();
  });

  it('keeps the issuer byte-for-byte, trailing slash included, because ID tokens are compared against it', () => {
    expect(loadEnv({ ...MINIMUM, ...SSO }).SINGLE_SIGN_ON_ISSUER_URL).toBe(
      'https://tenant.auth0.com/',
    );
  });

  it('refuses a plaintext issuer or base address on a non-loopback host', () => {
    expect(() =>
      loadEnv({ ...MINIMUM, ...SSO, SINGLE_SIGN_ON_ISSUER_URL: 'http://tenant.auth0.com/' }),
    ).toThrow(/SINGLE_SIGN_ON_ISSUER_URL must be an https URL/);
    expect(() =>
      loadEnv({ ...MINIMUM, ...SSO, PUBLIC_BASE_URL: 'http://bot.example.com' }),
    ).toThrow(/PUBLIC_BASE_URL must be an https URL/);
    expect(
      loadEnv({
        ...MINIMUM,
        ...SSO,
        SINGLE_SIGN_ON_ISSUER_URL: 'http://127.0.0.1:4000/',
        PUBLIC_BASE_URL: 'http://localhost:3000',
      }).PUBLIC_BASE_URL,
    ).toBe('http://localhost:3000');
  });

  it('refuses a base address that carries a path or credentials', () => {
    expect(() =>
      loadEnv({ ...MINIMUM, ...SSO, PUBLIC_BASE_URL: 'https://bot.example.com/app' }),
    ).toThrow(/origin only/);
    expect(() =>
      loadEnv({ ...MINIMUM, ...SSO, PUBLIC_BASE_URL: 'https://user:pw@bot.example.com' }),
    ).toThrow(/origin only/);
  });

  it('refuses single sign-on on the live demo', () => {
    expect(() => loadEnv({ ...MINIMUM, ...SSO, LIVE_DEMO: 'true' })).toThrow(
      /SINGLE_SIGN_ON_ENABLED and LIVE_DEMO cannot both be true/,
    );
  });

  it('requires the base address and the MCP resource to share one origin', () => {
    const mcp = { MCP_ENABLED: 'true', MCP_RESOURCE_URL: 'https://other.example.com/api/mcp' };
    expect(() => loadEnv({ ...MINIMUM, ...SSO, ...mcp })).toThrow(
      /PUBLIC_BASE_URL must be the same origin as MCP_RESOURCE_URL/,
    );
    expect(
      loadEnv({ ...MINIMUM, ...SSO, ...mcp, MCP_RESOURCE_URL: 'https://bot.example.com/api/mcp' })
        .MCP_ENABLED,
    ).toBe(true);
  });
});
