/** Resolve after `ms` ms. The real-clock default behind injectable sleep/opts.sleep seams. */
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
