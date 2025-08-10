// app/cronjob/marginSafety.js
// Auto-repay for Cross Margin – beskytter mot lavt margin level.

require('dotenv').config();
const { slack } = require('../helpers/slack');
const { getMarginAccount, repayAsset } = require('../binance/margin');

const STABLE_ASSET = (process.env.MARGIN_STABLE_ASSET || 'USDC').toUpperCase();
const MARGIN_SAFETY_LEVEL = parseFloat(process.env.MARGIN_SAFETY_LEVEL || '1.20');
const MARGIN_SAFETY_MIN_REPAY = parseFloat(process.env.MARGIN_SAFETY_MIN_REPAY || '5');
const MARGIN_SAFETY_MAX_REPAY_PCT = Math.min(
  Math.max(parseFloat(process.env.MARGIN_SAFETY_MAX_REPAY_PCT || '0.25'), 0),
  1
);

const toNum = v => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

const pickAsset = (assets, symbol) =>
  (assets || []).find(a => String(a.asset).toUpperCase() === String(symbol).toUpperCase()) || null;

async function run() {
  console.log('[marginSafety] Start');

  const acct = await getMarginAccount();

  // Støtt både nye/eldre feltnavn
  const level =
    toNum(acct.collateralMarginLevel) ||
    toNum(acct.marginLevel) ||
    0;

  const assets = acct.userAssets || acct.assets || [];
  const a = pickAsset(assets, STABLE_ASSET);

  if (!a) {
    console.log(`[marginSafety] Fant ikke asset ${STABLE_ASSET} i margin-kontoen.`);
    return;
  }

  const free = toNum(a.free);
  const borrowed = toNum(a.borrowed);
  const interest = toNum(a.interest);
  const outstanding = Math.max(0, borrowed + interest);

  console.log(
    JSON.stringify(
      {
        level,
        safetyLevel: MARGIN_SAFETY_LEVEL,
        asset: STABLE_ASSET,
        free,
        borrowed,
        interest,
        outstanding
      },
      null,
      2
    )
  );

  if (level >= MARGIN_SAFETY_LEVEL) {
    console.log('[marginSafety] Margin level er over sikkerhetsterskel. Ingen tiltak.');
    return;
  }

  if (outstanding <= 0) {
    console.log(`[marginSafety] Ingen utestående ${STABLE_ASSET}-lån. OK.`);
    return;
  }

  // Beregn trygt repay-beløp denne runden
  const capByPct = outstanding * MARGIN_SAFETY_MAX_REPAY_PCT;
  const repayCandidate = Math.min(outstanding, free, capByPct);

  if (repayCandidate < MARGIN_SAFETY_MIN_REPAY) {
    const text =
      `*Margin Safety – under terskel, men kan ikke repaye*\n` +
      `- Margin level: *${level.toFixed(3)}* (terskel ${MARGIN_SAFETY_LEVEL})\n` +
      `- Utestående ${STABLE_ASSET}: ${outstanding}\n` +
      `- Tilgjengelig ${STABLE_ASSET}: ${free}\n` +
      `- MIN_REPAY: ${MARGIN_SAFETY_MIN_REPAY}, cap pr kjøring: ${(MARGIN_SAFETY_MAX_REPAY_PCT * 100).toFixed(0)}%`;
    console.log('[marginSafety] ' + text.replace(/\n/g, ' '));
    try {
      if (slack && typeof slack.sendMessage === 'function') {
        await slack.sendMessage(text);
      }
    } catch (e) {
      console.error('[marginSafety] Slack error:', e.message);
    }
    return;
  }

  // Gjennomfør repay
  const amountStr = String(repayCandidate.toFixed(8)); // trygg presisjon
  console.log(`[marginSafety] Prøver å repaye ${amountStr} ${STABLE_ASSET}...`);
  try {
    const res = await repayAsset({ asset: STABLE_ASSET, amount: amountStr });
    console.log('[marginSafety] repayAsset result:', res);

    const okMsg =
      `*Margin Safety – auto-repay utført*\n` +
      `- Margin level: *${level.toFixed(3)}*\n` +
      `- Repayet: ${amountStr} ${STABLE_ASSET}`;
    try {
      if (slack && typeof slack.sendMessage === 'function') {
        await slack.sendMessage(okMsg);
      }
    } catch (e) {
      console.error('[marginSafety] Slack error:', e.message);
    }
  } catch (err) {
    console.error('[marginSafety] REPAY FEIL:', err.message || err);
    try {
      if (slack && typeof slack.sendMessage === 'function') {
        await slack.sendMessage(
          `*Margin Safety – REPAY FEIL*\n- Forsøkte: ${amountStr} ${STABLE_ASSET}\n- Feil: ${err.message || err}`
        );
      }
    } catch (_) { }
  }

  console.log('[marginSafety] Ferdig.');
}

module.exports = { run };

// Direkte kjøring: `node app/cronjob/marginSafety.js`
if (require.main === module) {
  run().catch(err => {
    console.error('[marginSafety] ERROR:', err.message, err.body || '');
    process.exit(1);
  });
}
