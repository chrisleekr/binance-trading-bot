// @ts-nocheck — vendored MIT code; upstream uses looser strict-mode
/**
 * SPDX-License-Identifier: MIT
 * Ported from bennycode/trading-signals @ 537d859 (v7.4.3, 2026-05-19).
 * https://github.com/bennycode/trading-signals
 * © 2018-2026 Benny Neugebauer. Original MIT license retained.
 * No semantic edits; only this header prepended.
 */
export type HighLow<T = number> = {
  high: T;
  low: T;
};

export type HighLowClose<T = number> = HighLow<T> & {
  close: T;
};

export type OpenHighLowClose<T = number> = HighLowClose<T> & {
  open: T;
};

export type OpenHighLowCloseVolume<T = number> = OpenHighLowClose<T> & {
  volume: T;
};

export type HighLowCloseVolume<T = number> = Omit<OpenHighLowCloseVolume<T>, 'open'>;
