import { useCallback, useMemo, useState } from 'react';

/** Where a cursor-paged list currently sits, plus the moves it allows. */
export interface CursorPager {
  /** The opaque cursor the next fetch must send, or null on the first page. Belongs in the query key: two cursors are two different answers to one URL. */
  readonly cursor: string | null;
  /** 1-based page number for display. */
  readonly pageNumber: number;
  /** False on the first page, where there is nothing to retrace to. */
  readonly canGoBack: boolean;
  /** Advance, remembering the page being left so `back` can retrace it. */
  readonly next: (nextCursor: string) => void;
  /** Step back to the previous page; a no-op on the first. */
  readonly back: () => void;
  /** Return to the first page. Every filter change must call this: a cursor is a position in one particular sequence, and replaying it against a different filter or sort key pages through a sequence the operator never saw. */
  readonly reset: () => void;
}

interface PageState {
  readonly cursor: string | null;
  /** Stack of the cursors already visited, oldest first. The CURRENT page's cursor is not on it, it is `cursor`. */
  readonly history: readonly (string | null)[];
}

const INITIAL: PageState = { cursor: null, history: [] };

/**
 * Forward/back paging over an opaque keyset cursor, for a list whose server hands back one `nextCursor` at a time.
 *
 * A cursor names a boundary row, not an offset, so there is no arithmetic that can reach the previous page: going back means remembering where you came from. That stack is the whole substance of this hook, and it was written twice — once in the archive panel and once beside the audit panel — which is why the second copy is the one that never learned to reset. Both lists are about to take a sort key, and a cursor minted under one ordering walks a different sequence under another, so `reset` has to be the same call in both places.
 *
 * @returns The current position and the three moves, each stable across renders so a consumer can pass them straight to a button without re-rendering its subtree.
 */
export function useCursorPager(): CursorPager {
  const [page, setPage] = useState<PageState>(INITIAL);

  const next = useCallback((nextCursor: string): void => {
    setPage((p) => ({ cursor: nextCursor, history: [...p.history, p.cursor] }));
  }, []);

  const back = useCallback((): void => {
    setPage((p) => {
      const last = p.history.at(-1);
      if (last === undefined) return p;
      return { cursor: last, history: p.history.slice(0, -1) };
    });
  }, []);

  const reset = useCallback((): void => {
    setPage(INITIAL);
  }, []);

  return useMemo(
    () => ({
      cursor: page.cursor,
      pageNumber: page.history.length + 1,
      canGoBack: page.history.length > 0,
      next,
      back,
      reset,
    }),
    [page, next, back, reset],
  );
}
