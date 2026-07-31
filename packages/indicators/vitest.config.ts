import { defineProject } from '../config/vitest/index.js';

// packageName opts into the 100% lines/branches gate registered in
// packages/config/vitest/index.js — indicator math is money-correctness
// critical, so a coverage regression must fail the build.
export default defineProject({ packageName: '@app/indicators' });
