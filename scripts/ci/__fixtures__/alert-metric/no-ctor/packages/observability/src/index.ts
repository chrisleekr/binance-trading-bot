// An observability module that constructs no prom-client metric. The real repo
// always has some, so finding none means the file walk stopped resolving source
// (a moved directory, a widened skip list) rather than that the sinks went away.
// Passing on an empty scan would silently drop every constructor-declared name
// from the allowed set, so the gate fails instead.

export const buildRegistry = (): Record<string, never> => ({});
