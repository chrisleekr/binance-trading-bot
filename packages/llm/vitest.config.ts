import { defineProject } from '../config/vitest/index.js';

// packageName opts into the floor-gated lines/branches thresholds registered in
// packages/config/vitest/index.js — a regression guard, not a 100% mandate,
// because llm.ts is a thin Anthropic-SDK client with an unmocked network path.
export default defineProject({ packageName: '@app/llm' });
