import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env.js';

describe('@app/api env', () => {
  it('parses a valid env block', () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      PORT: '3000',
      WEB_ORIGIN: 'http://localhost:5173',
      DATABASE_URL: 'postgres://app@localhost/app',
      REDIS_URL: 'redis://localhost:6379',
      AUTH_SECRET: 'x'.repeat(32),
    });
    expect(env.PORT).toBe(3000);
    // A single origin parses to a one-element allowlist.
    expect(env.WEB_ORIGIN).toEqual(['http://localhost:5173']);
  });

  it('parses a comma-separated WEB_ORIGIN into a trimmed allowlist', () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      WEB_ORIGIN: 'http://localhost:5173, http://192.168.1.50:5173 ,',
      DATABASE_URL: 'postgres://app@localhost/app',
      REDIS_URL: 'redis://localhost:6379',
      AUTH_SECRET: 'x'.repeat(32),
    });
    // Each entry trimmed; the trailing empty entry is dropped.
    expect(env.WEB_ORIGIN).toEqual(['http://localhost:5173', 'http://192.168.1.50:5173']);
  });

  it('rejects a WEB_ORIGIN that holds no origin after trimming', () => {
    expect(() =>
      loadEnv({
        NODE_ENV: 'test',
        WEB_ORIGIN: ' , ',
        DATABASE_URL: 'postgres://app@localhost/app',
        REDIS_URL: 'redis://localhost:6379',
        AUTH_SECRET: 'x'.repeat(32),
      }),
    ).toThrow(/WEB_ORIGIN/);
  });

  it('rejects a WEB_ORIGIN entry containing a wildcard', () => {
    expect(() =>
      loadEnv({
        NODE_ENV: 'test',
        WEB_ORIGIN: 'http://localhost:5173,https://*.example.com',
        DATABASE_URL: 'postgres://app@localhost/app',
        REDIS_URL: 'redis://localhost:6379',
        AUTH_SECRET: 'x'.repeat(32),
      }),
    ).toThrow(/wildcard/);
  });

  it('rejects missing AUTH_SECRET', () => {
    expect(() =>
      loadEnv({
        NODE_ENV: 'test',
        WEB_ORIGIN: 'http://localhost:5173',
        DATABASE_URL: 'postgres://app@localhost/app',
        REDIS_URL: 'redis://localhost:6379',
      }),
    ).toThrow(/AUTH_SECRET/);
  });

  it('defaults PGSSLMODE to prefer when unset', () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      WEB_ORIGIN: 'http://localhost:5173',
      DATABASE_URL: 'postgres://app@localhost/app',
      REDIS_URL: 'redis://localhost:6379',
      AUTH_SECRET: 'x'.repeat(32),
    });
    expect(env.PGSSLMODE).toBe('prefer');
  });

  it('rejects a PGSSLMODE outside the libpq enum', () => {
    expect(() =>
      loadEnv({
        NODE_ENV: 'test',
        WEB_ORIGIN: 'http://localhost:5173',
        DATABASE_URL: 'postgres://app@localhost/app',
        REDIS_URL: 'redis://localhost:6379',
        AUTH_SECRET: 'x'.repeat(32),
        PGSSLMODE: 'bogus',
      }),
    ).toThrow(/PGSSLMODE/);
  });

  it('defaults ADMIN_HOST to loopback when unset', () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      WEB_ORIGIN: 'http://localhost:5173',
      DATABASE_URL: 'postgres://app@localhost/app',
      REDIS_URL: 'redis://localhost:6379',
      AUTH_SECRET: 'x'.repeat(32),
    });
    expect(env.ADMIN_HOST).toBe('127.0.0.1');
  });

  it('rejects an empty ADMIN_HOST', () => {
    expect(() =>
      loadEnv({
        NODE_ENV: 'test',
        WEB_ORIGIN: 'http://localhost:5173',
        DATABASE_URL: 'postgres://app@localhost/app',
        REDIS_URL: 'redis://localhost:6379',
        AUTH_SECRET: 'x'.repeat(32),
        ADMIN_HOST: '',
      }),
    ).toThrow(/ADMIN_HOST/);
  });
});
