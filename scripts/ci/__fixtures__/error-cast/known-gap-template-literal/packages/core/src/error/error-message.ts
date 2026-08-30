// A caller that writes `(err as Error).message` throws when the thrown value is a primitive or null.
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
