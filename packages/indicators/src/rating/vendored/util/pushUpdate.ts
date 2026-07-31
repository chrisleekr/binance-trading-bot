// @ts-nocheck — vendored MIT code; upstream uses looser strict-mode
/**
 * SPDX-License-Identifier: MIT
 * Ported from bennycode/trading-signals @ 537d859 (v7.4.3, 2026-05-19).
 * https://github.com/bennycode/trading-signals
 * © 2018-2026 Benny Neugebauer. Original MIT license retained.
 * No semantic edits; only this header prepended.
 */
/**
 * Adds an item to the array or replaces the last item in the array.
 * If the array limit size is exceeded, the oldest array element will be removed and returned by the function.
 */
export function pushUpdate<T>(array: T[], replace: boolean, item: T, maxLength: number) {
  if (array.length > 0 && replace === true) {
    array[array.length - 1] = item;
  } else {
    array.push(item);
  }

  if (array.length > maxLength) {
    return array.shift();
  }

  return null;
}
