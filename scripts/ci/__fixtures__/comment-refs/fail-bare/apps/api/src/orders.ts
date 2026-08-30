// The reconciler re-stamps the row on every wake (#436), which is why the write
// has to be idempotent.
export const RESTAMP = true;

// A two-digit reference is the same defect and must be caught by the same
// pattern: narrowing the bound to 3-4 digits would ship green over the live
// (#34)-shaped refs this gate exists to remove.
export const SHORT_REF = true;
