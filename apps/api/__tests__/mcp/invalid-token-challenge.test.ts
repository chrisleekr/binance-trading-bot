// The header rewrite on its own, without infrastructure: the route test proves it is wired to a presented refused token, this one pins each branch of the rewrite.

import { describe, expect, it } from 'vitest';
import { withInvalidTokenError } from '../../src/routes/mcp.js';

const refused = (challenge: string | null): Response =>
  new Response('{"jsonrpc":"2.0","error":{"code":-32000,"message":"x"},"id":null}', {
    status: 401,
    headers: {
      'content-type': 'application/json',
      ...(challenge === null ? {} : { 'www-authenticate': challenge }),
    },
  });

describe('withInvalidTokenError', () => {
  it('leads the library Bearer challenge with invalid_token and keeps its parameters, status and body', async () => {
    const out = withInvalidTokenError(
      refused(
        'Bearer resource_metadata="https://x.test/.well-known/oauth-protected-resource/api/mcp", scope="mcp:read offline_access"',
      ),
    );
    expect(out.headers.get('www-authenticate')).toBe(
      'Bearer error="invalid_token", resource_metadata="https://x.test/.well-known/oauth-protected-resource/api/mcp", scope="mcp:read offline_access"',
    );
    expect(out.status).toBe(401);
    expect(out.headers.get('content-type')).toBe('application/json');
    expect(await out.text()).toContain('"code":-32000');
  });

  it('adds the attribute to a bare Bearer challenge without a dangling separator', () => {
    expect(withInvalidTokenError(refused('Bearer')).headers.get('www-authenticate')).toBe(
      'Bearer error="invalid_token"',
    );
  });

  it('leaves a challenge that already names an error untouched', () => {
    const res = refused('Bearer error="invalid_token"');
    expect(withInvalidTokenError(res)).toBe(res);
  });

  it('leaves a non-Bearer challenge untouched', () => {
    const res = refused('DPoP algs="ES256"');
    expect(withInvalidTokenError(res)).toBe(res);
  });

  it('leaves a response with no challenge untouched', () => {
    const res = refused(null);
    expect(withInvalidTokenError(res)).toBe(res);
  });
});
