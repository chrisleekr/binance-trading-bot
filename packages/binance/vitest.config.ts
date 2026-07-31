import { defineProject } from '../config/vitest/index.js';

// packageName opts into the 100% lines/branches gate registered in
// packages/config/vitest/index.js — the Binance REST/WS boundary must stay
// fully covered (a regression here is a money-path or rate-limit regression).
export default defineProject({ packageName: '@app/binance' });
