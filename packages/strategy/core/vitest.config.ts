import { defineProject } from '../../config/vitest/index.js';

// packageName opts into the 100% lines/branches gate registered in
// packages/config/vitest/index.js — the plugin contract + Executor are a
// money-correctness surface, so the threshold must actually fire.
export default defineProject({ packageName: '@app/strategy-core' });
