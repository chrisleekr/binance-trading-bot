import { defineProject } from '../../config/vitest/index.js';

// packageName opts into the floor gate registered in
// packages/config/vitest/index.js. The backtest engine is an offline analysis
// tool, so it is floor-gated (regression guard) rather than at the strategy
// plugins' 100% money-correctness bar.
export default defineProject({ packageName: '@app/strategy-backtest' });
