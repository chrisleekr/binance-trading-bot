import { describe, expect, it } from 'vitest';

import { assertDistinctPorts } from '../src/ports.js';

describe('assertDistinctPorts', () => {
  it('accepts distinct ports', () => {
    expect(() => assertDistinctPorts([3000, 9100, 9101])).not.toThrow();
  });

  it('rejects a collision and names the ports', () => {
    expect(() => assertDistinctPorts([3000, 9100, 9100])).toThrow(/9100/);
    expect(() => assertDistinctPorts([9100, 9100])).toThrow(/distinct ports/);
  });
});
