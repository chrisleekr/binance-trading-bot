// The screenshot set the docs site ships, as data.
//
// One entry per capture. `dest` lists the files under
// `docs/assets/screenshots/` it writes; a screen documented on two pages has
// two destinations rather than two captures. This is the single source of
// truth for both ends of the loop: `docs-screenshots.mjs` captures from it and
// `scripts/ci/no-stale-screenshot.sh` checks the committed PNGs against it, so
// a screen added to one and forgotten in the other fails CI instead of quietly
// shipping a stale image.
//
// `route` is a path template resolved against the seeded stack:
//   {acc}            account root, `/accounts/<id>`
//   {prof}           trailing-trade profile root, `/accounts/<id>/profiles/<id>`
//   {momentumProf}   momentum profile root
//   {rebalanceProf}  rebalance profile root
//   {symbol}         a symbol the screenshotted profile HOLDS, so the trade,
//                    orders and market panels have content rather than an
//                    empty state
//
// Entries with no `route` are captured by a scripted interaction in
// `docs-screenshots.mjs` (a wizard step, an overlay) — they still declare their
// destinations here so the gate sees the complete set.

/**
 * @typedef {object} Shot
 * @property {string} name Capture id; also the scripted-shot handler key.
 * @property {readonly string[]} dest Paths under `docs/assets/screenshots/`.
 * @property {string} [route] Path template, omitted for scripted captures.
 */

/** @type {readonly Shot[]} */
export const SHOTS = [
  // ── Account ────────────────────────────────────────────────────────────────
  { name: 'dashboard', route: '{acc}', dest: ['user-guide/dashboard.png'] },
  { name: 'account-manage', route: '{acc}/settings', dest: ['user-guide/account-manage.png'] },
  { name: 'account-api-key', route: '{acc}/api-key', dest: ['user-guide/account-api-key.png'] },
  {
    name: 'account-dust-transfer',
    route: '{acc}/dust-transfer',
    dest: ['user-guide/account-dust-transfer.png'],
  },
  {
    name: 'account-orphan-orders',
    route: '{acc}/orphan-orders',
    dest: ['user-guide/account-orphan-orders.png'],
  },

  // ── System (global, not account-scoped) ────────────────────────────────────
  { name: 'system-settings', route: '/settings', dest: ['user-guide/system-settings.png'] },
  {
    name: 'system-backup-restore',
    route: '/settings/backup-restore',
    dest: ['user-guide/system-backup-restore.png'],
  },

  // ── Profile sections ───────────────────────────────────────────────────────
  { name: 'profile-overview', route: '{prof}', dest: ['user-guide/profile-overview.png'] },
  { name: 'profile-general', route: '{prof}/general', dest: ['user-guide/profile-general.png'] },
  {
    name: 'profile-discovery',
    route: '{prof}/discovery',
    dest: ['user-guide/profile-discovery.png'],
  },
  {
    // The Trailing Trade profile's config form. It doubles as the User Guide's
    // Strategy-tab shot, since that tab IS this form.
    name: 'profile-strategy',
    route: '{prof}/config',
    dest: ['user-guide/profile-strategy.png', 'concepts/strategy-trailing-trade.png'],
  },
  // One capture per strategy: the config form is generated from the selected
  // strategy's own schema, so a single shot reused on three concept pages showed
  // Trailing Trade's fields on the Momentum and Rebalance pages.
  {
    name: 'strategy-momentum',
    route: '{momentumProf}/config',
    dest: ['concepts/strategy-momentum.png'],
  },
  {
    name: 'strategy-rebalance',
    route: '{rebalanceProf}/config',
    dest: ['concepts/strategy-rebalance.png'],
  },
  { name: 'profile-risk', route: '{prof}/risk', dest: ['user-guide/profile-risk.png'] },
  {
    name: 'profile-notifications',
    route: '{prof}/notifications',
    dest: ['user-guide/profile-notifications.png'],
  },
  { name: 'profile-live-gate', route: '{prof}/gate', dest: ['user-guide/profile-live-gate.png'] },
  // The History page's three views are one route with a `?section=` param.
  // Addressing them by URL (rather than by the retired `/audit` + `/archive`
  // redirects, which both landed on the default tab) is what stops these three
  // captures being byte-identical.
  {
    name: 'profile-history-activity',
    route: '{prof}/history?section=activity',
    dest: ['user-guide/profile-history-activity.png'],
  },
  {
    name: 'profile-history-audit',
    route: '{prof}/history?section=audit',
    dest: ['user-guide/profile-history-audit.png'],
  },
  {
    name: 'profile-bulk-order',
    route: '{prof}/bulk-order',
    dest: ['user-guide/profile-bulk-order.png'],
  },
  {
    name: 'profile-backtest-configure',
    route: '{prof}/backtest?view=configure',
    dest: ['user-guide/profile-backtest-configure.png'],
  },
  {
    name: 'profile-backtest-results',
    route: '{prof}/backtest?view=results',
    dest: ['user-guide/profile-backtest-results.png'],
  },
  {
    name: 'profile-backtest-history',
    route: '{prof}/backtest?view=history',
    dest: ['user-guide/profile-backtest-history.png'],
  },

  // ── Symbol workspace ───────────────────────────────────────────────────────
  {
    name: 'symbol-workspace-trade',
    route: '{prof}/symbols/{symbol}?tab=trade',
    dest: ['user-guide/symbol-workspace-trade.png'],
  },
  {
    name: 'symbol-workspace-orders',
    route: '{prof}/symbols/{symbol}?tab=orders',
    dest: ['user-guide/symbol-workspace-orders.png'],
  },
  {
    name: 'symbol-workspace-market',
    route: '{prof}/symbols/{symbol}?tab=market',
    dest: ['user-guide/symbol-workspace-market.png'],
  },
  {
    name: 'symbol-workspace-logs',
    route: '{prof}/symbols/{symbol}?tab=logs',
    dest: ['user-guide/symbol-workspace-logs.png'],
  },
  {
    name: 'symbol-workspace-config',
    route: '{prof}/symbols/{symbol}/config',
    dest: ['user-guide/symbol-workspace-config.png'],
  },

  // ── New-profile wizard ─────────────────────────────────────────────────────
  {
    name: 'profile-wizard',
    route: '{acc}/profiles/new',
    dest: ['get-started/profile-wizard.png'],
  },
  // Scripted: the strategy picker only renders once step 1 has a name.
  { name: 'profile-wizard-step2', dest: ['get-started/profile-wizard-step2.png'] },
  // Scripted: an overlay opened from the profile header.
  { name: 'manage-profile-sheet', dest: ['user-guide/manage-profile-sheet.png'] },
];
