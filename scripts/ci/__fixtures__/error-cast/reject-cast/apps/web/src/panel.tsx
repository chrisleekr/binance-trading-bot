export function Panel({ err }: { err: unknown }) {
  return <span>{(err as Error).message}</span>;
}
