// Profile manager and its boot rehydration loader.
//
// `loadEnabledProfiles` is returned separately from the manager because the
// periodic fleet reconciler re-reads the SAME enabled set the boot rehydration
// uses, so both must call one loader. The manager's market back-edge is injected
// later (fleet builder) once the subscriptions manager exists.

import type { Logger } from 'pino';

import { ProfileNotOwnedError, profileRepo, repo, type Database } from '@app/db';
import { asAccountId, asProfileId } from '@app/contracts';

import {
  createProfileManager,
  type ProfileLoadRow,
  type ProfileManager,
} from 'profile-manager/profile-manager.js';
import { resolveTechnicalsIntervals } from 'profile-manager/technicals-intervals.js';

export interface ProfileManagerDeps {
  readonly db: Database;
  readonly logger: Logger;
}

export interface ProfileManagerSlice {
  readonly loadEnabledProfiles: () => Promise<ProfileLoadRow[]>;
  readonly profileManager: ProfileManager;
}

export const buildProfileManagerSlice = ({
  db,
  logger,
}: ProfileManagerDeps): ProfileManagerSlice => {
  const loadEnabledProfiles = async (): Promise<ProfileLoadRow[]> => {
    // Crash-only rehydration: re-subscribe every enabled profile's
    // market streams from durable DB state on boot. Without
    // this a worker restart goes dark until an API-driven enable
    // event happens to fire. The `'1h'` candleInterval fallback
    // mirrors the tick-context builder and pipeline-worker subscribe
    // path so this rehydration and the tick-read agree.
    const rows = await repo.profiles.listAllEnabled(db);
    const loaded: ProfileLoadRow[] = [];
    for (const profile of rows) {
      const operatorId = profile.operatorId;
      const accountId = asAccountId(profile.accountId);
      const profileId = asProfileId(profile.id);
      // A profile deleted between `listAllEnabled` and this resolve
      // rejects with `ProfileNotOwnedError`; skip the stale row and
      // keep rehydrating the rest rather than aborting the whole boot.
      let symbolRows;
      try {
        const p = await profileRepo(db, operatorId, accountId, profileId);
        symbolRows = await p.profileSymbols.listForProfile();
      } catch (err) {
        if (err instanceof ProfileNotOwnedError) {
          logger.warn(
            { operatorId, accountId, profileId },
            'loadEnabledProfiles: profile disappeared during boot; skipping',
          );
          continue;
        }
        throw err;
      }
      const cfg = profile.config as { candleInterval?: unknown };
      loaded.push({
        userId: operatorId,
        operatorId,
        accountId,
        profileId,
        symbols: symbolRows.map((r) => r.symbol),
        candleInterval: typeof cfg.candleInterval === 'string' ? cfg.candleInterval : '1h',
        technicalsIntervals: resolveTechnicalsIntervals(profile.config),
      });
    }
    return loaded;
  };
  const profileManager = createProfileManager({ loadEnabledProfiles });
  return { loadEnabledProfiles, profileManager };
};
