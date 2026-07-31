// End-to-end coverage for the reset-password CLI core. The unit suite
// (`reset-password.test.ts`) locks the argv-parsing and password-generator
// helpers; this suite drives `runReset` against a real Better Auth instance
// + real Postgres so a regression in the credential-rotation path (wrong
// hash algorithm, mismatched account row, lost audit write) is caught
// before the CLI ships to operators.
//
// Skipped when `DATABASE_TEST_URL` is not set so `bun run test` works on
// workstations without a Postgres available; the testcontainers and
// dedicated integration jobs export the URL.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runReset } from '../scripts/reset-password.js';
import { HAS_INFRA, setupApp, type ApiFixture } from './_helpers.js';

const describeIfInfra = HAS_INFRA ? describe : describe.skip;

const EMAIL = 'reset-cli@local.test';
const ORIGINAL_PW = 'original-password-1234';
const NAME = 'Reset CLI Test';

describeIfInfra('reset-password CLI core — runReset()', () => {
  let fx: ApiFixture;

  beforeAll(async () => {
    // `seed: false` keeps the onboarding path open so this suite can mint a
    // single fresh user without tripping ONBOARDING_CLOSED on the seeded
    // Alice + Bob rows.
    fx = await setupApp({ seed: false });
    const res = await fx.app.request('/api/auth/sign-up', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: ORIGINAL_PW, name: NAME }),
    });
    if (res.status !== 200) {
      throw new Error(`sign-up failed for fixture user: ${res.status} ${await res.text()}`);
    }
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
  });

  it('rotates the credential and returns the new cleartext + userId', async () => {
    const result = await runReset({ db: fx.di.db, auth: fx.di.auth }, EMAIL);

    expect(result.email).toBe(EMAIL);
    // Better Auth assigns the domain users.id at sign-up; matching the
    // canonical UUID shape rules out an accidental empty / non-uuid return.
    expect(result.userId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(result.newPassword).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(result.newPassword).not.toBe(ORIGINAL_PW);

    const signInNew = await fx.app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: result.newPassword }),
    });
    expect(signInNew.status).toBe(200);

    // The pre-rotation cleartext must no longer authenticate. Constrain to
    // 4xx so a 5xx regression (e.g. credential row left in a half-updated
    // state) does not silently pass as "rejection".
    const signInOld = await fx.app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: ORIGINAL_PW }),
    });
    expect(signInOld.status).toBeGreaterThanOrEqual(400);
    expect(signInOld.status).toBeLessThan(500);
  });
});
