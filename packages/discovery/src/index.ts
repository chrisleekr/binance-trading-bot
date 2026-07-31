// Public API of the pure discovery brain. The Slice-3 cron fetches market data
// and persistence, then drives this chain; nothing here performs I/O.
export type {
  CurrentAutoSymbol,
  DiscoveryConfig,
  DiscoveryDiff,
  DiscoveryInput,
  DiscoveryTicker,
  RankContext,
  TrendConfirmConfig,
} from './types.js';
export {
  heldLongEnough,
  inCooldown,
  isActive,
  matchesQuote,
  meetsLiquidity,
  MIN_UNIVERSE_FOR_RANK,
  notBlacklisted,
  oldEnough,
  trendConfirmed,
  volumeSma,
  withinChangeBand,
  withinSpread,
} from './filters.js';
export {
  buildRankContext,
  marketBreadthOk,
  resolveDiscovery,
  runDiscovery,
  shortlistByTicker,
  tickerStageCounts,
} from './run.js';
export type { TickerStageCounts } from './run.js';
export { explainDiscovery } from './explain.js';
export type {
  CandidateExplain,
  DiscoveryDisposition,
  DiscoveryExplain,
  DiscoveryFilterName,
  SiblingConflictDisposition,
} from './explain.js';
export { projectFunnel } from './funnel.js';
export type { DiscoveryFunnel } from './funnel.js';
export { backtestDiscovery } from './backtest.js';
export type {
  DiscoveryBacktestStep,
  DiscoveryBacktestResult,
  DiscoveryCostModel,
} from './backtest.js';
