import { Decimal } from '@app/money';
import { errorMessage } from '@app/core/error';

/** Tagged result: the parsed Decimal, or a thrown error message on failure. */
export type DecimalParse =
  | { readonly ok: true; readonly value: Decimal }
  | { readonly ok: false; readonly err: string };

/** Parse a decimal-string into a tagged result. */
export const parseDecimal = (raw: string): DecimalParse => {
  try {
    return { ok: true, value: new Decimal(raw) };
  } catch (err) {
    return { ok: false, err: errorMessage(err) };
  }
};

/** Parse a decimal-string, returning null on failure. */
export const safeDecimal = (raw: string): Decimal | null => {
  const parsed = parseDecimal(raw);
  return parsed.ok ? parsed.value : null;
};
