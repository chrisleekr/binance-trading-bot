import { defineProject } from '../../packages/config/vitest/index.js';

// Each backtest replay test runs a real engine twice in ~1 s alone, but CI's shared runner starves it past the 5 s default under coverage. A timed-out test also leaves its replay running, which inflates the next test's shared spy counts, so the ceiling is lifted rather than the failures retried.
export default defineProject({ packageName: '@app/worker', test: { testTimeout: 30_000 } });
