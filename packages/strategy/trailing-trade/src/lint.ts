// Pure config lint for trailing-trade. Flags settings that are silently inert
// or conflicting given the rest of the config — the gotchas the schema cannot
// reject because each field is individually valid. Each rule mirrors a real
// branch in the tick path, so a diagnostic means the worker genuinely ignores
// the setting as written. Pure and deterministic; no I/O.

import type { ConfigDiagnostic } from '@app/strategy-core';
import type { TTConfig } from './schema.js';

/**
 * Lint a schema-valid TTConfig. Returns advisory diagnostics (never hard
 * errors — those are the schema's job). An empty array means nothing inert.
 */
export const lintTTConfig = (config: TTConfig): readonly ConfigDiagnostic[] => {
  const out: ConfigDiagnostic[] = [];
  const buy = config.buy;

  // Entry sizing is only consulted on the no-grid flat-entry path; with a grid
  // ladder the tick sizes each promotion from that level's own min/max, so the
  // entry-sizing amount/percent is silently ignored. The schema requires a
  // non-empty amount/percent on a valid config, so a grid profile always
  // carries an inert entry size — flag it whenever a ladder is present.
  if (buy.gridLevels.length > 0) {
    out.push({
      level: 'warn',
      code: 'entry-sizing-ignored-in-grid',
      message:
        'Entry sizing is ignored because a grid ladder is configured — each grid level sizes its own buy from its min/max amount. Remove the grid levels to use entry sizing, or set the sizes on the levels.',
      path: ['buy', 'entrySizing'],
    });
  }

  // candleLimit only feeds the lowest-price first-buy window scan; in
  // 'immediate' mode the first buy enters from flat and never reads it. Flag
  // only a non-default value, so an untouched config stays quiet.
  if (buy.firstBuyTriggerBasis === 'immediate' && buy.candleLimit !== 60) {
    out.push({
      level: 'info',
      code: 'candle-limit-inert-immediate',
      message:
        'Candle limit only affects the lowest-price first-buy trigger. The first buy basis is "immediate", so this value is ignored. Switch the basis to lowest-price to use it.',
      path: ['buy', 'candleLimit'],
    });
  }

  // Maker offset only feeds the passive-limit entry price; in market (taker)
  // mode no limit is placed, so a non-zero offset is silently ignored. Flag
  // only a non-default value so an untouched config stays quiet. Fields are
  // read non-optionally: lint runs on a schema-valid config (same as buy above).
  const execution = config.execution;
  if (execution.entryMode === 'market' && execution.makerOffsetBps !== '0') {
    out.push({
      level: 'info',
      code: 'maker-offset-inert-market',
      message:
        'The maker offset only applies to passive (maker) entries. Entry mode is "market", so it is ignored. Switch entry mode to "maker" to use it.',
      path: ['execution', 'makerOffsetBps'],
    });
  }

  // The entry timeout only cancels a RESTING passive entry; a market (taker)
  // entry fills immediately and never rests, so the timeout has nothing to act
  // on. Flag a non-zero value in market mode so the operator knows it is inert.
  if (execution.entryMode === 'market' && execution.entryTimeoutBars > 0) {
    out.push({
      level: 'info',
      code: 'entry-timeout-inert-market',
      message:
        'The entry timeout only applies to passive (maker) entries. Entry mode is "market", so it is ignored — a market entry fills immediately and never rests. Switch entry mode to "maker" to use it.',
      path: ['execution', 'entryTimeoutBars'],
    });
  }

  // In maker mode the buy leg pays the maker fee, which the round-trip profit
  // floor and the backtest both read. A zero maker fee understates the real
  // cost (at Binance VIP0 the maker fee equals the taker fee), so nudge the
  // operator to set it. Only fires once they have opted into maker entries.
  if (execution.entryMode === 'maker' && config.fees.makerBps === '0') {
    out.push({
      level: 'warn',
      code: 'maker-mode-zero-maker-fee',
      message:
        'Entry mode is "maker" but the maker fee is 0, so the profit floor and backtest understate your real cost. At Binance VIP0 the maker fee equals the taker fee — set fees.makerBps to your real maker fee.',
      path: ['fees', 'makerBps'],
    });
  }

  // Bear re-arm hooks into the bear-block entry path, which the tick reaches
  // only when neither of two gates overrides it. Each silently makes an enabled
  // rearm inert, so flag whichever is on:
  //   - exitToCash: re-arming during cash rotation would buy straight back into
  //     the bear it just sold out of, so evaluateRegimeRearm force-blocks it.
  //   - onBull.requireEntry: that gate replaces the bear-block branch entirely,
  //     so evaluateRegimeRearm is never even called.
  const onBear = config.regime?.onBear;
  const onBull = config.regime?.onBull;
  if (onBear?.rearm?.enabled === true) {
    if (onBear.exitToCash === true) {
      out.push({
        level: 'warn',
        code: 'rearm-ignored-exit-to-cash',
        message:
          'Bear re-arm never fires while "exit to cash" is on — cash rotation stays in cash. Turn off exit-to-cash to let re-arm catch an early recovery, or turn off re-arm to silence this.',
        path: ['regime', 'onBear', 'rearm'],
      });
    } else if (onBull?.requireEntry === true) {
      out.push({
        level: 'warn',
        code: 'rearm-ignored-require-entry',
        message:
          'Bear re-arm never fires while "require an uptrend to enter" is on — that gate replaces the bear-block path re-arm hooks into. Turn off require-uptrend to let re-arm work, or turn off re-arm to silence this.',
        path: ['regime', 'onBear', 'rearm'],
      });
    }
  }

  // A technicals row that allows "Buy" but not "Strong Buy" silently blocks the
  // STRONG_BUY reading — the strongest bullish signal — and the buy gate logs it
  // as a veto (`technicals-disallowed`). Allowing a weaker bull level while
  // rejecting the stronger one is almost never intended (this is the #534 trap
  // where a 15m Strong-Buy was vetoed and read as a sell). The reverse — only
  // Strong Buy checked — is a coherent "be more selective" choice and is left
  // alone. Fires per offending interval row.
  config.technicals.intervals.forEach((row, i) => {
    if (row.whenBuy && !row.whenStrongBuy) {
      out.push({
        level: 'warn',
        code: 'technicals-strong-buy-unchecked',
        message:
          `On the ${row.interval} technicals row you allow "Buy" but not "Strong Buy", so a Strong Buy — ` +
          `the strongest bullish reading — will BLOCK the buy instead of allowing it. Check "Strong Buy" ` +
          `on the ${row.interval} row to allow it (this is likely a mistake).`,
        path: ['technicals', 'intervals', String(i), 'whenStrongBuy'],
      });
    }
  });

  return out;
};
