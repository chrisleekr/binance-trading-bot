import { defineProject } from '../../config/vitest/index.js';

// packageName opts into the 100% lines/branches gate registered in
// packages/config/vitest/index.js — a strategy package's coverage is a
// money-correctness gate, so the threshold must actually fire.
export default defineProject({ packageName: '@app/strategy-momentum' });
