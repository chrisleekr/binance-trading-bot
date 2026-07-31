/**
 * Extract a human-readable message from an unknown thrown value. Callers catch
 * `unknown`; a bare `(err as Error).message` throws when the thrown value is a
 * primitive or null, and `String(err)` alone loses a real Error's `.message`.
 * This narrows once so operator-facing strings stay consistent everywhere.
 *
 * Not for the pino `err` log key: that must carry the raw Error so pino's `err`
 * serializer can emit the stack. Use this only for message strings and returns.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
