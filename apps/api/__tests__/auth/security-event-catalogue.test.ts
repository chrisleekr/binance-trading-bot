// Every security event the catalogue promises must have something that emits it. The type system already refuses an emitter naming an event the catalogue lacks; this is the other direction, which it cannot see: a catalogue entry nothing records would show on the Security page's legend and in the docs as covered while never appearing.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SECURITY_EVENT_CATALOG } from '@app/contracts';
import { describe, expect, it } from 'vitest';

const roots = ['../../src/', '../../scripts/'].map((r) =>
  fileURLToPath(new URL(r, import.meta.url)),
);

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory()
      ? sources(full)
      : full.endsWith('.ts')
        ? [readFileSync(full, 'utf8')]
        : [];
  });

describe('security event catalogue', () => {
  const corpus = roots.flatMap(sources).join('\n');

  it('reaches the emitters it checks', () => {
    // A walk that lost its root would make every lookup below fail for the wrong reason, or a partial one pass for the wrong reason.
    expect(corpus).toContain("event: 'sign-in-failed'");
    expect(corpus).toContain("event: 'reset-password-cli'");
  });

  it.each(Object.keys(SECURITY_EVENT_CATALOG))('%s has an emitter', (event) => {
    expect(corpus).toContain(`'${event}'`);
  });

  it('keeps the probing and denial-of-service noise aggregated and pins the notify level of a lockout, a command-line reset and a successful sign-in', () => {
    for (const [event, meta] of Object.entries(SECURITY_EVENT_CATALOG)) {
      if (
        [
          'auth-endpoint-denied',
          'cross-site-request-blocked',
          'api-request-limited',
          'password-check-overloaded',
          'websocket-connection-limited',
          'rate-limited',
        ].includes(event)
      ) {
        expect(meta.aggregated, event).toBe(true);
      }
    }
    expect(SECURITY_EVENT_CATALOG['account-locked'].notify).toBe('alert');
    expect(SECURITY_EVENT_CATALOG['reset-password-cli'].notify).toBe('alert');
    expect(SECURITY_EVENT_CATALOG['sign-in-succeeded'].notify).toBe('activity');
  });
});
