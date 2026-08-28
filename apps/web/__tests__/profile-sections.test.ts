// PROFILE_NAV_ITEMS — the ordered destination list the sidebar's expanded profile and the mobile Profiles sheet both render.
//
// Order is a product decision the module states in prose ("Overview first, then the groups in NAV_GROUP_ORDER"), and both consumers assert only that links exist, in no particular order. Without these two cases, renaming a group in PROFILE_SECTIONS would silently sort Backtest and History to the bottom of every profile's navigation with a fully green suite.

import { describe, expect, it } from 'vitest';

import {
  NAV_GROUP_ORDER,
  PROFILE_NAV_ITEMS,
  PROFILE_SECTION_LABELS,
  PROFILE_SECTIONS,
} from '@/features/profile/lib/profile-sections';

describe('PROFILE_NAV_ITEMS', () => {
  it('leads with Overview, then runs the groups in NAV_GROUP_ORDER', () => {
    expect(PROFILE_NAV_ITEMS.map((i) => i.testId)).toEqual([
      'overview',
      'backtest',
      'history',
      'config',
      'risk',
      'live-gate',
      'discovery',
      'notifications',
      'bulk-order',
      'general',
    ]);
  });

  it('names every PROFILE_SECTIONS group in NAV_GROUP_ORDER', () => {
    // A group missing here still renders — it sorts last rather than vanishing,
    // which is why the module sorts rather than filters — but it lands somewhere
    // nobody chose. This is the only place that would say so.
    const unranked = PROFILE_SECTIONS.map((g) => g.group).filter(
      (g) => !NAV_GROUP_ORDER.includes(g),
    );
    expect(unranked).toEqual([]);
  });

  it('gives every nav destination a distinct route, so the label map is total', () => {
    // Asserting get(item.to) === item.label per item would be a tautology: the
    // map is BUILT from this same list. What can actually break is a duplicate
    // `to` — Map keeps the last write, so the earlier row would silently borrow
    // the later row's label and the breadcrumb would name the wrong section.
    expect(PROFILE_SECTION_LABELS.size).toBe(PROFILE_NAV_ITEMS.length);
  });
});
