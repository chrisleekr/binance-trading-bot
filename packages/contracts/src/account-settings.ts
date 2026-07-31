import { z } from 'zod';

/**
 * True when `value` is an IANA time-zone identifier the host runtime accepts.
 *
 * `Intl.DateTimeFormat` is the only cross-platform validator available without
 * shipping a zone table: an unknown zone throws `RangeError`, which we map to
 * `false`. The same check runs on the API (reject the write) and the client.
 */
const isValidIanaZone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

/**
 * `GET /account/settings`. `.default('UTC')` keeps mocked client fixtures that
 * omit the field green and matches the column default, so a row written before
 * the column existed still parses.
 */
export const AccountSettingsResponse = z.object({
  timezone: z.string().default('UTC'),
});
export type AccountSettingsResponse = z.infer<typeof AccountSettingsResponse>;

/**
 * `PATCH /account/settings` body. The zone must be a non-empty IANA identifier
 * the runtime can resolve; an invalid one is a 422, never a stored value the
 * formatter then chokes on. The `.max(64)` bounds input before it reaches `Intl`
 * or the DB, independent of the refine (longest real IANA id is ~30 chars).
 */
export const UpdateTimezoneRequest = z.object({
  timezone: z.string().min(1).max(64).refine(isValidIanaZone, 'invalid IANA timezone'),
});
export type UpdateTimezoneRequest = z.infer<typeof UpdateTimezoneRequest>;
