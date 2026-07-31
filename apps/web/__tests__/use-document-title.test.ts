// titleFromMatches — the pure leaf→root title resolver behind useDocumentTitle.
// The route-level checks pin the title on five representative routes, then sweep
// the whole real router tree to guard every titled route against resolving to a
// raw i18n key (a mistyped `t()` key returns the key, not copy). The end-to-end
// document.title path through the real useMatches() lives in the sibling
// use-document-title.integration.test.tsx.

import { describe, expect, it } from 'vitest';

import { accountOverviewRoute } from '@/features/dashboard/routes/index';
import { settingsRoute } from '@/features/account/routes/settings';
import { configRoute } from '@/features/profile/routes/profiles.$profileId.config';
import { profileDetailRoute } from '@/features/profile/routes/profiles.$profileId';
import { symbolDetailRoute } from '@/features/symbol/routes/profiles.$profileId.symbols.$symbol';
import { router } from '@/router';

import { titleFromMatches } from '../src/app/use-document-title.js';

// Minimal shape of a TanStack router match the resolver walks: the optional
// per-route staticData title plus that match's resolved params.
type TitleMatch = {
  staticData?: { title?: string | ((params: Record<string, string>) => string) };
  params: Record<string, string>;
};

describe('titleFromMatches', () => {
  it('returns a string title set on the leaf match', () => {
    const matches: TitleMatch[] = [
      { staticData: { title: 'Root' }, params: {} },
      { staticData: { title: 'Dashboard' }, params: {} },
    ];
    expect(titleFromMatches(matches)).toBe('Dashboard');
  });

  it('resolves a function title against the leaf match params', () => {
    const matches: TitleMatch[] = [
      {
        staticData: { title: (p) => (p.symbol ? p.symbol.toUpperCase() : 'Symbol') },
        params: { symbol: 'btcusdt' },
      },
    ];
    expect(titleFromMatches(matches)).toBe('BTCUSDT');
  });

  it('falls back to the nearest ancestor with a title when the leaf has none', () => {
    const matches: TitleMatch[] = [
      { staticData: { title: 'Profile' }, params: { profileId: 'p1' } },
      { params: { profileId: 'p1' } },
    ];
    expect(titleFromMatches(matches)).toBe('Profile');
  });

  it('returns null when no match in the chain defines a title', () => {
    const matches: TitleMatch[] = [{ params: {} }, { staticData: {}, params: {} }];
    expect(titleFromMatches(matches)).toBeNull();
  });
});

describe('route staticData.title', () => {
  it('dashboard overview route is titled Dashboard', () => {
    expect(accountOverviewRoute.options.staticData?.title).toBe('Dashboard');
  });

  it('settings route is titled Settings', () => {
    expect(settingsRoute.options.staticData?.title).toBe('Settings');
  });

  it('profile config route is titled Strategy config', () => {
    expect(configRoute.options.staticData?.title).toBe('Strategy config');
  });

  it('profile detail layout route is titled Profile', () => {
    expect(profileDetailRoute.options.staticData?.title).toBe('Profile');
  });

  it('symbol detail route derives its title from the symbol param', () => {
    const title = symbolDetailRoute.options.staticData?.title;
    expect(typeof title).toBe('function');
    expect((title as (p: { symbol: string }) => string)({ symbol: 'btcusdt' })).toBe('BTCUSDT');
  });
});

describe('every titled route resolves to real copy', () => {
  it('no route title resolves to an empty string or a raw i18n key', () => {
    let checked = 0;
    for (const route of router.flatRoutes) {
      const title = route.options.staticData?.title;
      if (title === undefined) continue;
      // Function titles need a param; a symbol satisfies both symbol routes and
      // is ignored by the fixed-string ones.
      const resolved = typeof title === 'function' ? title({ symbol: 'btcusdt' }) : title;
      expect(resolved.length, `route ${route.id} has an empty title`).toBeGreaterThan(0);
      // A mistyped `t('edit.…')` key falls through to the raw key, which starts
      // with the 'edit.' namespace — the exact silent failure this guards.
      expect(
        resolved.startsWith('edit.'),
        `route ${route.id} title is a raw key: ${resolved}`,
      ).toBe(false);
      checked += 1;
    }
    // Guard the guard: an empty flatRoutes would make the loop vacuously pass.
    // The nine i18n-backed leaf routes are the floor.
    expect(checked).toBeGreaterThanOrEqual(9);
  });
});
