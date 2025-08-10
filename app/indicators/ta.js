function ema(values, period) {
  const k = 2 / (period + 1);
  let emaPrev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const out = Array(values.length).fill(null);
  out[period - 1] = emaPrev;
  for (let i = period; i < values.length; i++) {
    emaPrev = values[i] * k + emaPrev * (1 - k);
    out[i] = emaPrev;
  }
  return out;
}

function rsi(closes, period = 14) {
  let gains = 0, losses = 0; const out = Array(closes.length).fill(null);
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) gains += d; else losses -= d; }
  let avgGain = gains / period, avgLoss = losses / period; out[period] = 100 - (100 / (1 + (avgGain / (avgLoss || 1e-10))));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]; const g = Math.max(d, 0), l = Math.max(-d, 0);
    avgGain = (avgGain * (period - 1) + g) / period; avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = 100 - (100 / (1 + (avgGain / (avgLoss || 1e-10))));
  }
  return out;
}

function macd(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = ema(closes, fast); const emaSlow = ema(closes, slow);
  const macdLine = closes.map((_, i) => (emaFast[i] != null && emaSlow[i] != null) ? emaFast[i] - emaSlow[i] : null);
  const valid = macdLine.map(v => v == null ? null : v);
  const signalLine = ema(valid.filter(v => v != null), signal);
  // realign
  let j = 0; const sigAligned = macdLine.map(v => v == null ? null : signalLine[j++]);
  const hist = macdLine.map((v, i) => (v != null && sigAligned[i] != null) ? v - sigAligned[i] : null);
  return { macdLine, signalLine: sigAligned, hist };
}

function atr(highs, lows, closes, period = 14) {
  const tr = [null];
  for (let i = 1; i < closes.length; i++) {
    tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
  }
  let sum = 0; for (let i = 1; i <= period; i++) sum += tr[i];
  const out = Array(closes.length).fill(null); out[period] = sum / period;
  for (let i = period + 1; i < tr.length; i++) out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
  return out;
}

module.exports = { ema, rsi, macd, atr };
