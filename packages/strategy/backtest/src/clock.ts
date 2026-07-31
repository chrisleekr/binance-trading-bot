import type { Clock } from '@app/strategy-core';

/**
 * Clock whose "now" is driven by the candle stream, not the wall clock.
 * The run loop advances it to each candle's close time before ticking, so
 * `clock.nowMs()` inside the strategy returns simulated time and the run is
 * deterministic. Using the wall clock here would both break determinism and
 * violate the strategy-package no-`Date` rule.
 */
export class SyntheticClock implements Clock {
  private current: number;

  constructor(startMs: number) {
    this.current = startMs;
  }

  nowMs(): number {
    return this.current;
  }

  advanceTo(ms: number): void {
    this.current = ms;
  }
}
