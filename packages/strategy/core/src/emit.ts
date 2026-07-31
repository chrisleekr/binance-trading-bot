// Shared log/metric construction for strategy plugins. Pure object
// constructors (no I/O), so they keep `tick()` pure (invariant #4). Every
// strategy emits the same way, so a change to the LogEntry / MetricEntry
// contract is one edit here, not N inline literals per plugin.

import type { LogEntry, MetricEntry } from './contract.js';

/**
 * Construct a {@link LogEntry}. `context` is omitted from the object when not
 * supplied, so the result is byte-identical to a bare `{ level, message }`.
 */
export const log = (
  level: LogEntry['level'],
  message: string,
  context?: LogEntry['context'],
): LogEntry => (context === undefined ? { level, message } : { level, message, context });

/**
 * Construct a {@link MetricEntry}. `value` defaults to 1 (the common counter
 * increment); `tags` is omitted from the object when not supplied.
 */
export const metric = (name: string, tags?: MetricEntry['tags'], value = 1): MetricEntry =>
  tags === undefined ? { name, value } : { name, value, tags };
