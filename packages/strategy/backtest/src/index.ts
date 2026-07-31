export type {
  MarketDataSource,
  StreamRequest,
  MarketTick,
  FillModel,
  FillInput,
  FillMarket,
  FillPhase,
  Fill,
  FillOutcome,
  FillRejectReason,
  BacktestTrade,
  EquityPoint,
  DrawdownPoint,
  BacktestMetrics,
  BacktestPerSymbol,
  BacktestReport,
  BacktestSummary,
  DecisionBreakdown,
  DecisionBreakdownMetric,
  DecisionBreakdownLog,
  MarketRegime,
  RegimeSegment,
  OutOfSampleSegment,
} from './types.js';

export { arrayMarketDataSource } from './portfolio-source.js';
export type { SymbolCandles } from './portfolio-source.js';

export { OhlcvFillModel } from './ohlcv-fill.js';
export type { OhlcvFillModelOptions } from './ohlcv-fill.js';
export { runBacktest } from './run.js';
export type { RunBacktestOptions } from './run.js';
