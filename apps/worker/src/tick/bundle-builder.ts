import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import {
  decimalString,
  ManualOverridePayload,
  TechnicalsSignalSchema,
  type ManualOverridePayload as ManualOverridePayloadT,
  type ProfileId,
  type AccountId,
  type TechnicalsBundleConfig,
  type TechnicalsIntervalSignal,
  type TechnicalsSignal,
  unwrapId,
} from '@app/contracts';
import { GLOBAL_KEYS, profileKey } from '@app/db';

import { commitPipeline, type PipeReply } from 'lib/redis-pipeline.js';
import {
  BUNDLE_PROVIDER_ENTRY_HINT,
  BUNDLE_PROVIDER_OVERRIDE,
  BUNDLE_PROVIDER_TECHNICALS,
} from 'tick/bundle-providers.js';

/**
 * Dependencies for {@link createTickBundleProvider}. `redis` is the raw
 * BullMQ-grade ioredis handle; `logger` is optional so a unit test can
 * drop it and let parse-failures stay silent (the test still asserts on
 * the `signal: null` outcome).
 */
export interface BundleProviderDeps {
  readonly redis: Redis;
  readonly logger?: Logger;
}

/**
 * What one tick's bundle read produced. `overrideTtlMs` is the override key's
 * remaining lifetime, captured in the same pipeline as the GET — i.e. BEFORE the
 * consuming DEL, which is the only moment it is still knowable. The tick handler
 * needs it to re-arm the key with the operator's ORIGINAL expiry when the
 * strategy could not act on the override; without it a re-arm would either
 * silently extend the operator's window or have to drop the override.
 *
 * It rides here rather than as a key on `bundle` because the bundle is handed to
 * strategy code verbatim (nothing re-parses it), and this is worker bookkeeping,
 * not a strategy input.
 */
export interface TickBundleResult {
  readonly bundle: Readonly<Record<string, unknown>>;
  readonly overrideTtlMs?: number;
}

/**
 * Parse a PTTL reply into a re-armable remaining lifetime in ms. Redis answers
 * -2 (no key) / -1 (no expiry), and a per-command error leaves the slot errored;
 * all three mean "no operator window to restore", so they read as absent and the
 * override is consumed rather than re-armed with a guessed TTL.
 */
const parseTtlReply = (reply: PipeReply | undefined): number | undefined => {
  if (!reply) return undefined;
  const [err, raw] = reply;
  if (err || typeof raw !== 'number' || raw <= 0) return undefined;
  return raw;
};

/**
 * Parse one Technicals signal reply slot. Returns `null` for: missing key,
 * per-command Redis error, malformed JSON, or schema-failed payload. Each
 * failure mode logs at `warn` so upstream contract drift surfaces in
 * dashboards instead of silently degrading the gate.
 */
const parseSignalReply = (
  reply: PipeReply | undefined,
  symbol: string,
  interval: string,
  logger: Logger | undefined,
): TechnicalsSignal | null => {
  if (!reply) return null;
  const [err, raw] = reply;
  if (err) {
    logger?.warn({ symbol, interval, err: err }, 'bundle-builder: technicals row reply errored');
    return null;
  }
  if (typeof raw !== 'string') return null;
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (e) {
    logger?.warn({ symbol, interval, err: e }, 'bundle-builder: malformed JSON in technicals row');
    return null;
  }
  const parsed = TechnicalsSignalSchema.safeParse(parsedJson);
  if (!parsed.success) {
    logger?.warn(
      { symbol, interval, issues: parsed.error.issues },
      'bundle-builder: technicals row failed schema',
    );
    return null;
  }
  return parsed.data;
};

/**
 * Parse the trailing override reply slot. Mirrors the failure-mode policy
 * of {@link parseSignalReply}: malformed payloads log at warn and return
 * `null`. Returning `null` is safer than throwing — the operator's
 * override is lost, but the tick still runs the normal strategy path;
 * throwing would DLQ the tick and stop every subsequent tick for this
 * symbol.
 */
const parseOverrideReply = (
  reply: PipeReply | undefined,
  symbol: string,
  logger: Logger | undefined,
): ManualOverridePayloadT | null => {
  if (!reply) return null;
  const [err, raw] = reply;
  if (err) {
    logger?.warn({ symbol, err: err }, 'bundle-builder: override row reply errored');
    return null;
  }
  if (typeof raw !== 'string') return null;
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (e) {
    logger?.warn({ symbol, err: e }, 'bundle-builder: malformed JSON in override row');
    return null;
  }
  const parsed = ManualOverridePayload.safeParse(parsedJson);
  if (!parsed.success) {
    logger?.warn(
      { symbol, issues: parsed.error.issues },
      'bundle-builder: override row failed schema',
    );
    return null;
  }
  return parsed.data;
};

/** The discovery entry-hint shape the strategy's `TTEntryHintBundleSchema` accepts. */
interface EntryHintBundle {
  readonly enterOnAdd: boolean;
  readonly high24h?: string;
  readonly maxDistanceFrom24hHighPercent?: string;
  readonly knifeCandles?: number;
  readonly knifeDropPercent?: string;
}

/**
 * Decode the discovery entry-hint hash value into the strategy entry-hint (#473;
 * broadened to all discovery symbols in #486). Three shapes, in order of tolerance:
 *
 *   - rich JSON `{ at, enterOnAdd?, high24h?, maxDistanceFrom24hHighPercent?,
 *     knifeCandles?, knifeDropPercent? }` (current writer): arm with the guard
 *     fields present and the explicit `enterOnAdd` flag (default true when the
 *     key is absent, matching the legacy enterOnAdd-only writer below).
 *   - a bare number string `"<addedAtMs>"` (legacy writer): arm enterOnAdd-only,
 *     no guard fields, so an old hash entry keeps relaxing the gate exactly as
 *     before with no anti-chase behaviour.
 *   - anything else (malformed JSON / wrong type): not armed (return null),
 *     failing safe to the strict gate rather than a half-built hint.
 *
 * Every field this emits must be one the strategy's `bundleSchema` would accept:
 * the tick boundary parses the assembled bundle before `tick()`, so a field that
 * survives here but fails that schema fails-CLOSED the whole tick (DLQ), turning
 * an advisory hint into a lost exit. So each guard field is validated to the same
 * constraint the schema enforces and DROPPED when invalid — a degraded hint stays
 * armed on its valid fields rather than poisoning the bundle.
 */
const nonNegativeDecimal = decimalString('entry-hint field must be a non-negative decimal', {
  gte: 0,
});
const parseEntryHintValue = (raw: string): EntryHintBundle | null => {
  // Legacy bare-number value: the whole string is the added-at ms.
  if (/^\d+$/.test(raw.trim())) return { enterOnAdd: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || !('at' in parsed)) return null;
  const p = parsed as Record<string, unknown>;
  const hint: EntryHintBundle = {
    // A flag-less rich payload predates #486 and was only written for enterOnAdd
    // symbols, so default true; the current writer always sets it explicitly.
    enterOnAdd: typeof p['enterOnAdd'] === 'boolean' ? p['enterOnAdd'] : true,
    ...(nonNegativeDecimal.safeParse(p['high24h']).success
      ? { high24h: p['high24h'] as string }
      : {}),
    ...(nonNegativeDecimal.safeParse(p['maxDistanceFrom24hHighPercent']).success
      ? { maxDistanceFrom24hHighPercent: p['maxDistanceFrom24hHighPercent'] as string }
      : {}),
    // Require a non-negative integer (the schema's shape): NaN/Infinity/fractional
    // would slip past a bare `typeof === 'number'` and `knifeGuard`'s `< 1`
    // off-switch (NaN < 1 is false), turning the knife window into the whole
    // candle array. This typeof check is the sole validation on the tick path.
    ...(typeof p['knifeCandles'] === 'number' &&
    Number.isInteger(p['knifeCandles']) &&
    p['knifeCandles'] >= 0
      ? { knifeCandles: p['knifeCandles'] }
      : {}),
    ...(nonNegativeDecimal.safeParse(p['knifeDropPercent']).success
      ? { knifeDropPercent: p['knifeDropPercent'] as string }
      : {}),
  };
  return hint;
};

/**
 * Produce a `bundleProvider` for the tick handler. The returned closure
 * captures `deps.redis` and assembles ONLY the providers the strategy
 * declares in `capabilities.bundleProviders` (passed per tick), matching the
 * backtest runner's `buildBundle`: a strategy that declares neither provider
 * (e.g. momentum) pays no Redis round-trip, and a strategy #3 selects its own
 * set without a code change here. When `technicals` is declared it runs
 * `GET technicals:<symbol>:<interval>` for every operator-configured interval;
 * when `override` is declared it adds a non-destructive `GET` of the per-symbol
 * override slot, in one pipeline.
 *
 * Override consume is decoupled from the signal read so the override
 * survives a degraded tick. ioredis `pipeline()` batches commands over
 * one round-trip but is NOT transactional, so a destructive in-pipeline
 * `GETDEL` would consume the override even when a sibling signal `GET`
 * errored — and the server-side delete cannot be undone, silently losing
 * the operator's override. Instead the override is read non-destructively
 * and only consumed (a separate `DEL`) on a healthy tick that will act on
 * it; an errored signal slot defers the override to the next clean tick.
 * The tick handler serialises ticks per (profile, symbol) via chainByKey,
 * so the GET-then-DEL pair cannot race a sibling tick on the same symbol.
 *
 * Per-command parse failures (malformed JSON, schema drift) surface
 * via `parseSignalReply` / `parseOverrideReply` returning `null` for
 * that slot, without touching neighbouring slots.
 *
 * The intervals to read are derived from `tvConfig.intervals` — every
 * operator-configured row contributes one signal slot. An empty config
 * yields an empty signals array, which the strategy treats as
 * "Technicals opted out" (gate fully open, no force-sell).
 */
export const createTickBundleProvider = (
  deps: BundleProviderDeps,
): ((
  accountId: AccountId,
  profileId: ProfileId,
  symbol: string,
  tvConfig: TechnicalsBundleConfig,
  bundleProviders: readonly string[],
) => Promise<TickBundleResult>) => {
  return async (accountId, profileId, symbol, tvConfig, bundleProviders) => {
    const wantsTechnicals = bundleProviders.includes(BUNDLE_PROVIDER_TECHNICALS);
    const wantsOverride = bundleProviders.includes(BUNDLE_PROVIDER_OVERRIDE);
    const wantsEntryHint = bundleProviders.includes(BUNDLE_PROVIDER_ENTRY_HINT);

    const bundle: Record<string, unknown> = {};
    // A strategy declaring no bundle providers (momentum) reads nothing — no
    // technicals/override/entry-hint Redis round-trip on its hot path.
    if (!wantsTechnicals && !wantsOverride && !wantsEntryHint) return { bundle };

    const intervals = wantsTechnicals ? tvConfig.intervals.map((row) => row.interval) : [];
    const overrideKey = profileKey({ accountId, profileId }, 'override', symbol);

    const pipe = deps.redis.pipeline();
    for (const interval of intervals) pipe.get(GLOBAL_KEYS.technicals(symbol, interval));
    // Record each non-technicals slot's index as it is pushed so a missing
    // provider does not shift the others (override-off, entry-hint-on must still
    // land on the right reply).
    let nextSlot = intervals.length;
    const overrideSlot = wantsOverride ? nextSlot++ : -1;
    // Read the override's remaining lifetime in the same round-trip as its value.
    // The DEL below destroys it, so this is the last point at which the operator's
    // original expiry window can be observed.
    const overrideTtlSlot = wantsOverride ? nextSlot++ : -1;
    const entryHintSlot = wantsEntryHint ? nextSlot++ : -1;
    if (wantsOverride) {
      pipe.get(overrideKey);
      pipe.pttl(overrideKey);
    }
    if (wantsEntryHint) pipe.hget(GLOBAL_KEYS.discoveryEnterOnAdd(unwrapId(profileId)), symbol);

    // Per-slot, read-tolerant scan: parseSignalReply/parseTtlReply degrade a
    // single errored GET to null and signalSlotErrored defers (not drops) the
    // override. Do NOT swap in the write-path commitPipelineChecked, which
    // fails the whole tick on the first per-command error.
    const replies = (await commitPipeline(pipe)) as readonly PipeReply[] | null;
    if (!Array.isArray(replies)) {
      // ioredis returns `null` from a committed pipeline only on the rare
      // connection-failure path that does not reject the promise (handled
      // here defensively in case `commitPipeline`'s contract evolves);
      // ordinary connection drops already surface as a rejection from
      // `commitPipeline`. Carry the per-tick context so the operator can
      // triage the DLQ'd tick without grepping for the symbol elsewhere.
      throw new Error(
        `bundle-builder: pipeline returned null (accountId=${String(accountId)} profileId=${String(
          profileId,
        )} symbol=${symbol} intervals=${intervals.length})`,
      );
    }

    let signalSlotErrored = false;
    if (wantsTechnicals) {
      const signals: TechnicalsIntervalSignal[] = intervals.map((interval, i) => ({
        interval,
        signal: parseSignalReply(replies[i], symbol, interval, deps.logger),
      }));
      signalSlotErrored = signals.some((_s, i) => replies[i]?.[0] != null);
      bundle['technicals'] = { config: tvConfig, signals };
    }

    let overrideTtlMs: number | undefined;
    if (wantsOverride) {
      const overrideReply = replies[overrideSlot];
      const overridePresent = overrideReply?.[0] == null && typeof overrideReply?.[1] === 'string';
      let override: ManualOverridePayloadT | null = null;
      if (signalSlotErrored) {
        // "If the signal read path broke, do not act on the override this
        // tick" — but unlike a destructive GETDEL, the non-transactional GET
        // above left the override slot intact, so a degraded tick DEFERS the
        // override to the next clean tick instead of losing it.
        if (overridePresent) {
          deps.logger?.warn(
            { accountId, profileId, symbol },
            'bundle-builder: deferring override — one or more signal slots errored',
          );
        }
      } else if (overridePresent) {
        // Healthy tick with a pending override: consume it (separate DEL)
        // BEFORE projecting it, so at-most-once holds even if the strategy
        // later acts. The DEL also clears a malformed row (parse already
        // logged) so a poison override does not re-warn every tick. Only
        // project the override if the DEL succeeded — acting on an override
        // we failed to consume risks double-applying it next tick.
        try {
          await deps.redis.del(overrideKey);
          override = parseOverrideReply(overrideReply, symbol, deps.logger);
        } catch (err) {
          deps.logger?.warn(
            { accountId, profileId, symbol, err: err },
            'bundle-builder: override consume (DEL) failed — deferring to next tick',
          );
          override = null;
        }
        // Only surface the TTL alongside an override we actually projected: it
        // exists to re-arm THIS override, and a re-arm without a payload to write
        // is meaningless.
        if (override) overrideTtlMs = parseTtlReply(replies[overrideTtlSlot]);
      }
      bundle['override'] = override;
    }

    if (wantsEntryHint) {
      // Presence of the symbol member in the discovery entry-hint hash arms the
      // hint (discovery refreshes it for every managed symbol each cycle, #486);
      // the payload's `enterOnAdd` flag decides whether the gate is relaxed.
      // Read-only — the hint persists until discovery clears it on reap, so no
      // consume/DEL.
      //
      // Deferred on a degraded technicals read (same posture as the override
      // above): if any signal slot errored we cannot confirm there is no fresh
      // STRONG_SELL, so we do NOT relax the gate this tick — leaving the hint
      // off falls back to the strict gate (which blocks on the missing signal)
      // and the next clean tick re-reads. A per-command error on the hint slot
      // itself also fails safe to "not armed".
      const hintReply = replies[entryHintSlot];
      const armed =
        !signalSlotErrored && hintReply?.[0] == null && typeof hintReply?.[1] === 'string';
      bundle['entryHint'] = armed ? parseEntryHintValue(hintReply[1] as string) : null;
    }

    return { bundle, ...(overrideTtlMs === undefined ? {} : { overrideTtlMs }) };
  };
};
