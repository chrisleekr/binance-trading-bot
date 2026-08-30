/**
 * A JSDoc block ahead of the violation, so the reported line number is only
 * right if comment bodies are blanked in place rather than deleted.
 */
export const bad = (err as Error).message;

// A prettier reflow splits the cast across lines, so a per-line matcher never sees it whole.
export const reflowed = (
  err as Error
).message;
