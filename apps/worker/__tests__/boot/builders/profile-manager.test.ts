import { describe, expect, it } from 'vitest';

import { buildProfileManagerSlice } from '../../../src/boot/builders/profile-manager.js';
import { fakeDb, silentLogger } from './fakes.js';

describe('buildProfileManagerSlice', () => {
  it('returns the shared loader and a manager with no active profiles at boot', () => {
    const { loadEnabledProfiles, profileManager } = buildProfileManagerSlice({
      db: fakeDb(),
      logger: silentLogger(),
    });
    // The loader is returned separately so the fleet reconciler re-reads the SAME
    // enabled set the boot rehydration uses.
    expect(typeof loadEnabledProfiles).toBe('function');
    expect(profileManager.listActive()).toEqual([]);
  });
});
