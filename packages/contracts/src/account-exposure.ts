// The account-exposure-cap "armed" rule, shared across the plugin boundary. The
// cap is strategy-owned config, but the worker (gating the per-tick deployed-
// quote DB aggregate) and the api (the dashboard gauge) both must duck-read it
// structurally — they cannot import the strategy package — and each had
// re-implemented the disarm semantics. A TT-side change (e.g. treating '0.0' as
// disarmed) would silently desync the worker gate and the gauge from the
// strategy's actual veto. Defining the rule once here keeps the three provably
// equal. The TT schema reuses `isCapArmed` so even its own check shares the rule.

/**
 * A stored decimal-string knob is armed iff it is a non-empty value other than
 * the literal '0'. An empty string or '0' means "off". This is the single owner
 * of the disarm rule for the string-valued caps (per-symbol exposure, loss
 * budget, and each mode's value inside the account cap); do not re-derive it.
 */
export const isCapArmed = (raw: unknown): boolean =>
  typeof raw === 'string' && raw !== '' && raw !== '0';

/** How the account-wide exposure cap is expressed. `off` = no cap. */
export type AccountCapMode = 'off' | 'amount' | 'percent';

/**
 * Structural read of the account-wide exposure cap. An `amount` cap is an
 * absolute quote ceiling; a `percent` cap is a fraction of account equity that
 * the consumer resolves against a live equity figure (the worker/api have it;
 * the cap stays per-(profile,symbol)-pure in the strategy). Exactly one of
 * `amount`/`percent` is non-null when armed.
 */
export interface AccountExposureCap {
  readonly armed: boolean;
  readonly mode: AccountCapMode;
  readonly amount: string | null;
  readonly percent: string | null;
}

/**
 * Read the account-wide exposure cap from a structurally-typed strategy config.
 * The worker tick-context needs only `armed`, to gate the cross-profile
 * deployed-quote aggregate; the api dashboard gauge resolves a `percent` cap
 * against equity. Both duck-read because they cannot import the strategy
 * package. An absent or unrecognised block, or a mode whose value is disarmed,
 * reads as off.
 *
 * Two config shapes exist and are normalised onto the one `AccountCapMode`:
 * TT nests the block under `buy.accountCap` and spells the equity-fraction mode
 * `percent`; momentum hangs it at the config root and spells that mode
 * `percentOfAccount`. The arithmetic is identical in both strategies
 * (`percent × equity − deployed`), so they collapse to `percent` here. Adding a
 * strategy with a third spelling means adding a branch — that duplication is
 * the known cost of invariant #1 forbidding a strategy import.
 */
export const readAccountExposureCap = (config: unknown): AccountExposureCap => {
  const off = { armed: false, mode: 'off', amount: null, percent: null } as const;
  type CapBlock = { mode?: unknown; amount?: unknown; percent?: unknown };
  const c = config as { buy?: { accountCap?: CapBlock }; accountCap?: CapBlock } | null;
  const cap = c?.buy?.accountCap ?? c?.accountCap;
  if (!cap) return off;
  if (cap.mode === 'amount' && isCapArmed(cap.amount)) {
    return { armed: true, mode: 'amount', amount: cap.amount as string, percent: null };
  }
  if ((cap.mode === 'percent' || cap.mode === 'percentOfAccount') && isCapArmed(cap.percent)) {
    return { armed: true, mode: 'percent', amount: null, percent: cap.percent as string };
  }
  return off;
};

/**
 * Whether a profile's resolved config needs the cross-profile deployed-quote
 * total injected into the tick. True when an account cap is armed (the cap's
 * headroom subtracts deployed) OR when entry sizing is a percent of account
 * equity (equity = cash + deployed). When false the worker skips the per-tick
 * deployed-quote aggregate, so this must stay in lock-step with every config
 * path that reads `deployedQuoteAcrossProfiles`.
 *
 * Every account-cap shape is delegated to {@link readAccountExposureCap} rather
 * than re-matched here: the one time this function grew its own momentum branch,
 * its sibling did not, and the api gauge silently reported no cap for a cap the
 * worker was enforcing.
 */
export const needsAccountDeployedQuote = (config: unknown): boolean => {
  if (readAccountExposureCap(config).armed) return true;
  const c = config as {
    entrySizing?: { mode?: unknown };
    buy?: { entrySizing?: { mode?: unknown } };
  } | null;
  // Percent-of-account entry sizing (TT `buy.entrySizing`, momentum `entrySizing`).
  if (c?.buy?.entrySizing?.mode === 'percentOfAccount') return true;
  if (c?.entrySizing?.mode === 'percentOfAccount') return true;
  return false;
};
