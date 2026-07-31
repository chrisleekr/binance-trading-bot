import { customType } from 'drizzle-orm/pg-core';

// Postgres `citext` (case-insensitive text). Requires `citext` extension.
export const citext = customType<{ data: string; driverData: string }>({
  dataType: () => 'citext',
});

// Decimal-string column. Money fields are `numeric(38,18)`; we always read/write
// as strings to keep IEEE-754 out of the data path. Strategies revive these into
// `Decimal` (decimal.js) at the boundary.
export const numeric38_18 = customType<{ data: string; driverData: string }>({
  dataType: () => 'numeric(38, 18)',
});

export const numeric20_10 = customType<{ data: string; driverData: string }>({
  dataType: () => 'numeric(20, 10)',
});
