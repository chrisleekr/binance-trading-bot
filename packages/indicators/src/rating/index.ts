// Public API for the rating subpath. Strategy code that needs the rating
// imports from `@app/indicators/rating`; the existing primitives at
// `@app/indicators` are unchanged.

export { computeTechnicalsRating } from './rating.js';
export type { TechnicalsRating, Vote } from './rating.js';

// Null-safe single-indicator helpers (return null when the window is too short)
// for consumers that need one reading rather than the full rating aggregate.
// The discovery trend-confirm filter uses adx + ema; both wrap the same vendored
// math the rating aggregate uses, so there is one source of truth per indicator.
export { adx, ema } from './adapter.js';
