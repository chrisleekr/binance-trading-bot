// app/binance/marginGuard.js
const { getMarginAccount } = require('./margin');

const MIN_LEVEL = parseFloat(process.env.MARGIN_MIN_LEVEL || '1.50');   // hard stop
const TARGET = parseFloat(process.env.MARGIN_TARGET_LEVEL || '2.00'); // ønsket gulv
const MAX_BORROW_RATIO = parseFloat(process.env.MARGIN_MAX_BORROW_RATIO || '0.30'); // 30%

/**
 * Leser margin-konto og returnerer en enkel vurdering:
 * { ok, level, borrowRatio, advice, snapshot }
 */
async function checkMarginHealth() {
  const a = await getMarginAccount();

  // Binance sender både "marginLevel" og "collateralMarginLevel".
  // Vi bruker collateralMarginLevel hvis den finnes.
  const level = parseFloat(a.collateralMarginLevel || a.marginLevel || '0');

  // Borrow ratio ~ total liability / total collateral value
  const liabilities = num(a.totalLiabilityOfBtc) || 0;
  const collateralUSDT = num(a.totalCollateralValueInUSDT) || 0;
  // grove anslag – vi holder oss til collateralUSDT hvis tilgjengelig
  let borrowRatio = 0;
  if (collateralUSDT > 0 && a.userAssets) {
    // summer alle borrowed i USDT ved å plukke USDT-linjen (enkelt og robust nok)
    const usdtLine = a.userAssets.find(x => x.asset === 'USDT' || x.asset === 'USDC');
    const borrowedUsd = usdtLine ? num(usdtLine.borrowed) : 0;
    borrowRatio = collateralUSDT > 0 ? borrowedUsd / collateralUSDT : 0;
  }

  let ok = true;
  const advice = [];

  if (!isFinite(level) || level <= 0) {
    ok = false;
    advice.push('Mangler gyldig marginLevel fra API – stopp trading til data kommer inn.');
  }
  if (level < MIN_LEVEL) {
    ok = false;
    advice.push(`Margin level (${level.toFixed(3)}) < MIN_LEVEL (${MIN_LEVEL}). Reduser posisjoner og/eller repay lån umiddelbart.`);
  } else if (level < TARGET) {
    advice.push(`Margin level (${level.toFixed(3)}) under TARGET (${TARGET}). Ikke øk eksponering før nivået er > TARGET.`);
  }

  if (borrowRatio > MAX_BORROW_RATIO) {
    ok = false;
    advice.push(`Borrow-ratio (${(borrowRatio * 100).toFixed(1)}%) > tillatt (${MAX_BORROW_RATIO * 100}%).`);
  }

  return {
    ok,
    level,
    borrowRatio,
    advice,
    snapshot: {
      collateralMarginLevel: a.collateralMarginLevel,
      totalCollateralValueInUSDT: a.totalCollateralValueInUSDT,
      totalAssetOfBtc: a.totalAssetOfBtc,
      totalLiabilityOfBtc: a.totalLiabilityOfBtc
    }
  };
}

function num(v) {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

module.exports = { checkMarginHealth };
