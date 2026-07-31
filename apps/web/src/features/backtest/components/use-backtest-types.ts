// Navigation types shared by the workbench composition root and its slices.
// Kept in a leaf module so the slice hooks can import them without importing the
// workbench itself (which imports the slices), avoiding an import cycle.

/**
 * The three workbench tabs; the active one lives in the `?view=` search param.
 * The tuple is the single source: the route validates against it and the hook
 * falls back through it, so adding a tab is one edit rather than three literal
 * lists nothing keeps in sync.
 */
export const TAB_KEYS = ['configure', 'results', 'history'] as const;
export type TabKey = (typeof TAB_KEYS)[number];

/** The route's search shape; kept here so the hooks can build navigations without
 * importing the route (which would cycle: route → hook → route). */
export interface BacktestSearch {
  symbol?: string;
  run?: string;
  /**
   * One-shot: launch a run on the current config as soon as the form is ready,
   * then drop the param. It is an instruction, not a mode — leaving it in the URL
   * would re-fire the run on every reload and back-navigation.
   */
  autorun?: boolean;
  // The active workbench tab. Named `view` (not `tab`) to avoid colliding with
  // the symbol-workspace route's differently-typed `tab` search param — a shared
  // key would widen the global `tab` union and break unrelated navigations.
  view?: TabKey;
}
