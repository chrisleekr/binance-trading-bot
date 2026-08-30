/**
 * A multi-line block so the stripper has something real to blank.
 * `(err as Error).message` in prose is not a violation.
 */
export const glob = 'src/**/*.ts';

// The same cast named in a line comment: `(err as Error).message` is prose here too.
export const ok = errorMessage(err);
