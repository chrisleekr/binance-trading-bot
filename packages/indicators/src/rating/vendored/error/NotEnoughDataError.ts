// @ts-nocheck — vendored MIT code; upstream uses looser strict-mode
/**
 * SPDX-License-Identifier: MIT
 * Ported from bennycode/trading-signals @ 537d859 (v7.4.3, 2026-05-19).
 * https://github.com/bennycode/trading-signals
 * © 2018-2026 Benny Neugebauer. Original MIT license retained.
 * No semantic edits; only this header prepended.
 */
export class NotEnoughDataError extends Error {
  constructor(requiredAmount: number) {
    super(
      `Not enough data. A minimum of "${requiredAmount}" inputs is required to perform the computation.`,
    );
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'NotEnoughDataError';
  }
}
