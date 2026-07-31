import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { HAS_INFRA, setupApp, type ApiFixture } from '../_helpers.js';

// `label` is `.optional()`, not `.nullable()` — the web client omits it when empty
// rather than sending null, and so must this fixture.
const PUT_BODY = JSON.stringify({ key: 'k'.repeat(20), secret: 's'.repeat(20) });

/**
 * Cross-account isolation contract at the API layer for the api-keys
 * routes. After #121, the repo layer raises {@link ProfileNotOwnedError} on
 * wrong-owner access; the error envelope (`apps/api/src/middleware/error.ts`)
 * maps that to a 404 with `code: NOT_FOUND` so the API never leaks the
 * existence of another user's profile. This suite locks that mapping in.
 */
const describeIfInfra = HAS_INFRA ? describe : describe.skip;

describeIfInfra('api-keys cross-account isolation (envelope mapping)', () => {
  let fx: ApiFixture;

  beforeAll(async () => {
    fx = await setupApp();
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
  });

  it('GET cross-account returns 404 NOT_FOUND, not 500', async () => {
    const res = await fx.app.request(`/api/accounts/${fx.alice.accountId}/api-key`, {
      method: 'GET',
      headers: { 'x-test-user-id': fx.bob.userId },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('PUT cross-account returns 404 NOT_FOUND, not 500', async () => {
    const res = await fx.app.request(`/api/accounts/${fx.alice.accountId}/api-key`, {
      method: 'PUT',
      headers: {
        'x-test-user-id': fx.bob.userId,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ key: 'planted', secret: 'planted' }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('DELETE cross-account returns 404 NOT_FOUND, not 500', async () => {
    const res = await fx.app.request(`/api/accounts/${fx.alice.accountId}/api-key`, {
      method: 'DELETE',
      headers: { 'x-test-user-id': fx.bob.userId },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  // A stored/rotated key must be re-verified: the PUT enqueues an account-scoped
  // verify-key job so the row's 'pending' status is resolved out of band.
  it('PUT enqueues a verify-key job for the account', async () => {
    const addSpy = vi.spyOn(fx.di.queue, 'add');
    const res = await fx.app.request(`/api/accounts/${fx.alice.accountId}/api-key`, {
      method: 'PUT',
      headers: { 'x-test-user-id': fx.alice.userId, 'content-type': 'application/json' },
      body: PUT_BODY,
    });
    expect(res.status).toBe(200);
    expect(addSpy).toHaveBeenCalledWith(
      'verify-key',
      { userId: fx.alice.userId, accountId: fx.alice.accountId },
      expect.anything(),
    );
    addSpy.mockRestore();
  });

  it('DELETE removes the key and enqueues nothing (credentials resolve per tick)', async () => {
    // Ensure a key exists to delete (independent of the PUT test's ordering).
    await fx.app.request(`/api/accounts/${fx.alice.accountId}/api-key`, {
      method: 'PUT',
      headers: { 'x-test-user-id': fx.alice.userId, 'content-type': 'application/json' },
      body: PUT_BODY,
    });
    const addSpy = vi.spyOn(fx.di.queue, 'add');
    const res = await fx.app.request(`/api/accounts/${fx.alice.accountId}/api-key`, {
      method: 'DELETE',
      headers: { 'x-test-user-id': fx.alice.userId },
    });
    expect(res.status).toBe(204);
    expect(addSpy).not.toHaveBeenCalled();
    addSpy.mockRestore();
  });
});
