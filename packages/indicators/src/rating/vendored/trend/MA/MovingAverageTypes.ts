// @ts-nocheck — vendored MIT code; upstream uses looser strict-mode
/**
 * SPDX-License-Identifier: MIT
 * Ported from bennycode/trading-signals @ 537d859 (v7.4.3, 2026-05-19).
 * https://github.com/bennycode/trading-signals
 * © 2018-2026 Benny Neugebauer. Original MIT license retained.
 * No semantic edits; only this header prepended.
 */
import type { EMA } from '../EMA/EMA.js';
import type { RMA } from '../RMA/RMA.js';
import type { SMA } from '../SMA/SMA.js';
import type { WMA } from '../WMA/WMA.js';
import type { WSMA } from '../WSMA/WSMA.js';

export type MovingAverageTypes = typeof EMA | typeof RMA | typeof SMA | typeof WMA | typeof WSMA;
