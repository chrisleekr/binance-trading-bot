// Lock the boundary: `buildBinanceClient` must pass `mode` and the api-key
// credentials through to `createBinanceRest` unchanged. A regression that
// dropped `secretKey` (or, worse, swapped it for `apiKey`) would silently
// authenticate every request as the public key and Binance would 401 every
// order — testing the wrapper here catches that without spinning the real
// REST client.

import { describe, expect, it, vi } from 'vitest';

const { createBinanceRestSpy } = vi.hoisted(() => ({
  createBinanceRestSpy: vi.fn().mockReturnValue({ __mock: 'rest-client' }),
}));

vi.mock('@app/binance', () => ({
  createBinanceRest: createBinanceRestSpy,
}));

const { buildBinanceClient } = await import('../../src/profile-bindings/binance-client.js');

describe('buildBinanceClient', () => {
  it('forwards mode and credentials verbatim into createBinanceRest', () => {
    createBinanceRestSpy.mockClear();
    const out = buildBinanceClient({ mode: 'test', apiKey: 'k', secretKey: 's' });
    expect(createBinanceRestSpy).toHaveBeenCalledTimes(1);
    expect(createBinanceRestSpy).toHaveBeenCalledWith({
      mode: 'test',
      credentials: { apiKey: 'k', secretKey: 's' },
    });
    expect(out).toEqual({ __mock: 'rest-client' });
  });

  it('does not leak extra fields (no fetchImpl / clock injection from bindings)', () => {
    createBinanceRestSpy.mockClear();
    buildBinanceClient({ mode: 'live', apiKey: 'k2', secretKey: 's2' });
    const call = createBinanceRestSpy.mock.calls[0]?.[0];
    expect(Object.keys(call ?? {}).sort()).toEqual(['credentials', 'mode']);
  });
});
