import { describe, expect, it } from 'vitest';
import { assertTestDatabaseUrl } from '../src/test-guard.js';
import { errorMessage } from '@app/core/error';

describe('assertTestDatabaseUrl', () => {
  it('rejects the live database (no _test suffix) — the wipe that prompted this guard', () => {
    expect(() =>
      assertTestDatabaseUrl('postgres://postgres:pw@localhost:55432/binance_trading_bot'),
    ).toThrow(/non-test database "binance_trading_bot"/);
  });

  it('accepts the CI test database', () => {
    expect(() =>
      assertTestDatabaseUrl('postgres://postgres:postgres@postgres:5432/binance_trading_bot_test'),
    ).not.toThrow();
  });

  it('accepts the local isolation test database', () => {
    expect(() =>
      assertTestDatabaseUrl('postgres://postgres:pw@localhost:55432/binance_test'),
    ).not.toThrow();
  });

  it('ignores query params when reading the database name', () => {
    expect(() =>
      assertTestDatabaseUrl('postgres://u:p@host:5432/binance_test?sslmode=disable'),
    ).not.toThrow();
    expect(() =>
      assertTestDatabaseUrl('postgres://u:p@host:5432/binance_trading_bot?sslmode=disable'),
    ).toThrow();
  });

  it('throws on a malformed URL', () => {
    expect(() => assertTestDatabaseUrl('not-a-url')).toThrow(/not a valid URL/);
  });

  it('masks credentials in the error message', () => {
    let message = '';
    try {
      assertTestDatabaseUrl('postgres://admin:supersecret@host:5432/prod');
    } catch (err) {
      message = errorMessage(err);
    }
    expect(message).not.toContain('supersecret');
    expect(message).toContain('***');
  });

  it('masks a password that contains an @ without leaking a fragment', () => {
    let message = '';
    try {
      assertTestDatabaseUrl('postgres://admin:p@ss@host:5432/prod');
    } catch (err) {
      message = errorMessage(err);
    }
    expect(message).not.toContain('ss@host'); // no partial-password leak
    expect(message).toContain('postgres://***@host:5432/prod');
  });
});
