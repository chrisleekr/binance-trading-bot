Deliberately holds none of the gate's roots: no `apps/`, `packages/`, `scripts/`,
`.github/` or `deploy/` tree, and no repo-root YAML file.

The walk's zero-file stop has to fail on a walk that finds nothing: a drift gate
reporting OK over zero scanned files is worse than no gate, and that is exactly
what a scan-path regression looks like from the outside.

Its sibling `narrowed-walk/` covers the other, quieter shape — a walk that still
returns a healthy count but no longer reaches the module its root exists to
protect.
