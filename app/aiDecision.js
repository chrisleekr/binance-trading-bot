const { ema, rsi, macd, atr } = require('../indicators/ta');

function lastN(arr, n) { return arr.slice(-n); }

function buildContext(klines) {
  const closes = klines.map(k => k.close);
  const highs = klines.map(k => k.high);
  const lows = klines.map(k => k.low);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const rsi14 = rsi(closes, 14);
  const mac = macd(closes, 12, 26, 9);
  const atr14 = atr(highs, lows, closes, 14);
  const i = closes.length - 1;
  return { i, closes, ema50, ema200, rsi14, mac, atr14 };
}

function crossover(aPrev, aNow, bPrev, bNow) { return aPrev != null && bPrev != null && aNow != null && bNow != null && aPrev <= bPrev && aNow > bNow; }
function crossunder(aPrev, aNow, bPrev, bNow) { return aPrev != null && bPrev != null && aNow != null && bNow != null && aPrev >= bPrev && aNow < bNow; }

function decide(ctx) {
  const i = ctx.i; const price = ctx.closes[i];
  const uptrend = ctx.ema50[i] != null && ctx.ema200[i] != null && ctx.ema50[i] > ctx.ema200[i];
  const downtrend = ctx.ema50[i] != null && ctx.ema200[i] != null && ctx.ema50[i] < ctx.ema200[i];

  const macCrossUp = crossover(ctx.mac.macdLine[i - 1], ctx.mac.macdLine[i], ctx.mac.signalLine[i - 1], ctx.mac.signalLine[i]);
  const macCrossDn = crossunder(ctx.mac.macdLine[i - 1], ctx.mac.macdLine[i], ctx.mac.signalLine[i - 1], ctx.mac.signalLine[i]);

  const rsiOkBuy = ctx.rsi14[i] != null && ctx.rsi14[i] < 70;
  const rsiOkSell = ctx.rsi14[i] != null && ctx.rsi14[i] > 30;

  const atr = ctx.atr14[i];

  const buy = uptrend && rsiOkBuy && macCrossUp;
  const sell = downtrend && rsiOkSell && macCrossDn;

  return { action: buy ? 'BUY' : (sell ? 'SELL' : 'HOLD'), price, atr };
}

module.exports = { buildContext, decide };
