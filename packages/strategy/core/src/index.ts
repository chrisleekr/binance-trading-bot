export type {
  OrderSide,
  OrderType,
  OrderStatus,
  TimeInForce,
  Clock,
  RNG,
  Candle,
  PercentPriceBySideFilter,
  TrailingDeltaFilter,
  SymbolFilters,
  SymbolInfo,
  ApiLimits,
  Balance,
  OpenOrder,
  ProfileSnapshot,
  MarketSnapshot,
  IndicatorSnapshot,
  AccountSnapshot,
  AccountSnapshotWire,
  TriggerEvent,
  Issue,
  ConfigDiagnostic,
  ProtectiveStopBandSettings,
  LogEntry,
  MetricEntry,
  Capabilities,
  StrategyEvent,
  StrategyEventMap,
  TickInput,
  TickOutput,
  Strategy,
  PositionView,
  AdoptedFill,
  PositionStateAdapter,
  ReasonAttribution,
  ReasonAttributionEntry,
  ReasonKind,
  PreviewTone,
  PreviewRow,
  PreviewSection,
  PreviewModel,
  PreviewInput,
} from './contract.js';

export { IssueCode } from './contract.js';

// Canonical kline-interval set lives in the leaf @app/contracts; re-exported
// here so strategy consumers keep importing it from @app/strategy-core.
export { CANDLE_INTERVALS, isCandleInterval } from '@app/contracts';
export type { CandleInterval } from '@app/contracts';

export { assertPreviewTickAgreement } from './preview-drift.js';

export {
  resolveFill,
  realizedPnlOnSell,
  isUnsellableDust,
  isBelowMinNotional,
  isValuelessResidue,
} from './fill-resolution.js';
export type { RawFill, RealizedPnl } from './fill-resolution.js';

export type { Decision, OrderIntent, OrderParams } from './decision.js';

export type {
  Executor,
  ExecutorContext,
  TickExecutorContext,
  DecisionResult,
  DecisionFailurePhase,
} from './executor.js';

export { createRegistry } from './registry.js';
export type { StrategyRegistry, AnyStrategy, ResolvedStrategy } from './registry.js';

export { assertDeterministic } from './determinism.js';
export type { DeterminismResult } from './determinism.js';

export { mergeConfig } from './merge-config.js';

// Shared plugin primitives — the protocol the contract forces on every
// strategy, implemented once so a new strategy inherits it instead of
// re-copying (state-adapter guards, clientOrderId length safety, sizing).
export { currentSchemaBody, asStringOrNull } from './state-body.js';
export { assertClientOrderId, djb2Hex } from './client-order-id.js';
export {
  configFingerprint,
  backtestSignature,
  signatureForBacktest,
} from './config-fingerprint.js';
export type { BacktestSignatureInput } from './config-fingerprint.js';
export { parseFilters, finalise } from './sizing.js';
export type { SizeFilters } from './sizing.js';
export { log, metric } from './emit.js';
export { resolveCandleWindow } from './window.js';
export { explainProtectiveStopBandRefusal } from './protective-stop-gloss.js';
export type { ProtectiveStopBandExplanation } from './protective-stop-gloss.js';
export {
  PROTECTIVE_STOP_BLOCKER_REASONS,
  armableBaseQuantity,
  classifyProtectiveStopRefusal,
  clampStopToExchangeFloor,
  clampedStopDrift,
  evaluateProtectiveStopArm,
  findForeignRestingSell,
  findRestingProtectiveStop,
  nativeTrailPreviewNote,
  ownRestingSellBase,
  percentPriceBySideRefusal,
  protectiveStopBandAdjustment,
  protectiveStopBandWarning,
  protectiveStopNeedsRearm,
} from './protective-stop.js';
export type {
  DesiredNativeTrailingStop,
  DesiredProtectiveStop,
  ProtectiveStopArm,
  ProtectiveStopArmParams,
  ProtectiveStopBlocker,
  ProtectiveStopBlockerReason,
  ProtectiveStopLevel,
  StopBandContext,
} from './protective-stop.js';
export { freeBalance, sizableBase, decOrNull, accountEquity } from './balances.js';
export type { SizableBase } from './balances.js';
