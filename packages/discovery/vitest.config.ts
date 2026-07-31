import { defineProject } from '../config/vitest/index.js';

// packageName opts into the 100% lines/branches gate registered in
// packages/config/vitest/index.js — the pure discovery brain must stay fully
// covered (a regression is a money-routing regression).
export default defineProject({ packageName: '@app/discovery' });
