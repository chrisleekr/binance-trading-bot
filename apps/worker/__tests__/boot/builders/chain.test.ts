import { describe, expect, it } from 'vitest';

import { buildChain } from '../../../src/boot/builders/chain.js';

describe('buildChain', () => {
  it('mints a ChainByKey whose run executes the passed work', async () => {
    const chain = buildChain();
    expect(typeof chain.run).toBe('function');
    await expect(chain.run('k', async () => 42)).resolves.toBe(42);
  });

  it('returns a distinct instance on each call', () => {
    expect(buildChain()).not.toBe(buildChain());
  });
});
