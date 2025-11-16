const _ = require('lodash');
const moment = require('moment');

/**
 * Calculate RSI (Relative Strength Index)
 *
 * @param {Array} closes - Array of closing prices
 * @param {number} period - RSI period (default 14)
 * @returns {number} RSI value
 */
const calculateRSI = (closes, period = 14) => {
  if (closes.length < period + 1) {
    return null;
  }

  const changes = [];
  for (let i = 1; i < closes.length; i += 1) {
    changes.push(closes[i] - closes[i - 1]);
  }

  let gains = 0;
  let losses = 0;

  // First average
  for (let i = 0; i < period; i += 1) {
    if (changes[i] >= 0) {
      gains += changes[i];
    } else {
      losses += Math.abs(changes[i]);
    }
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  // Calculate subsequent values using smoothing
  for (let i = period; i < changes.length; i += 1) {
    const change = changes[i];
    if (change >= 0) {
      avgGain = (avgGain * (period - 1) + change) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.abs(change)) / period;
    }
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  const rsi = 100 - 100 / (1 + rs);

  return rsi;
};

/**
 * Calculate EMA (Exponential Moving Average)
 *
 * @param {Array} data - Array of prices
 * @param {number} period - EMA period
 * @returns {number} EMA value
 */
const calculateEMA = (data, period) => {
  if (data.length < period) {
    return null;
  }

  const k = 2 / (period + 1);
  let ema = data[0];

  for (let i = 1; i < data.length; i += 1) {
    ema = data[i] * k + ema * (1 - k);
  }

  return ema;
};

/**
 * Calculate MACD (Moving Average Convergence Divergence)
 *
 * @param {Array} closes - Array of closing prices
 * @returns {Object} MACD values {macd, signal, histogram}
 */
const calculateMACD = (
  closes,
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9
) => {
  if (closes.length < slowPeriod + signalPeriod) {
    return { macd: null, signal: null, histogram: null };
  }

  // Calculate EMAs for the entire array progressively
  const emaFast = [];
  const emaSlow = [];

  for (let i = 0; i < closes.length; i += 1) {
    const dataSlice = closes.slice(0, i + 1);
    if (dataSlice.length >= fastPeriod) {
      emaFast.push(calculateEMA(dataSlice, fastPeriod));
    }
    if (dataSlice.length >= slowPeriod) {
      emaSlow.push(calculateEMA(dataSlice, slowPeriod));
    }
  }

  // Calculate MACD line
  const macdLine = [];
  const minLength = Math.min(emaFast.length, emaSlow.length);
  for (let i = 0; i < minLength; i += 1) {
    macdLine.push(
      emaFast[emaFast.length - minLength + i] -
        emaSlow[emaSlow.length - minLength + i]
    );
  }

  // Calculate signal line
  const signalLine = calculateEMA(macdLine, signalPeriod);
  const currentMACD = macdLine[macdLine.length - 1];
  const histogram = currentMACD - signalLine;

  return {
    macd: currentMACD,
    signal: signalLine,
    histogram
  };
};

/**
 * Calculate volume momentum
 *
 * @param {Array} volumes - Array of volume data
 * @param {number} period - Period for comparison
 * @returns {number} Volume ratio (current vs average)
 */
const calculateVolumeMomentum = (volumes, period = 20) => {
  if (volumes.length < period) {
    return 1;
  }

  const recentVolumes = volumes.slice(-period);
  const avgVolume = _.mean(recentVolumes);
  const currentVolume = volumes[volumes.length - 1];

  return currentVolume / avgVolume;
};

/**
 * Detect momentum based on multiple indicators
 *
 * @param {Object} candleData - Candle data with close, high, low, volume arrays
 * @param {Object} config - Momentum configuration
 * @returns {Object} Momentum analysis
 */
const detectMomentum = (candleData, config = {}) => {
  const {
    rsiPeriod = 14,
    rsiBuyThreshold = 30,
    rsiSellThreshold = 70,
    rsiMomentumThreshold = 50,
    volumeMultiplier = 1.5,
    macdEnabled = true
  } = config;

  const { close, volume = [] } = candleData;

  if (!close || close.length < 30) {
    return {
      hasMomentum: false,
      direction: null,
      strength: 0,
      reason: 'Insufficient data'
    };
  }

  // Calculate indicators
  const rsi = calculateRSI(close, rsiPeriod);
  const macd = calculateMACD(close);
  const volumeRatio = volume.length > 0 ? calculateVolumeMomentum(volume) : 1;

  let momentumScore = 0;
  let direction = null;
  const signals = [];

  // RSI signals
  if (rsi !== null) {
    if (rsi < rsiBuyThreshold) {
      momentumScore += 1;
      direction = 'bullish';
      signals.push(`RSI oversold (${rsi.toFixed(2)})`);
    } else if (rsi > rsiSellThreshold) {
      momentumScore -= 1;
      direction = 'bearish';
      signals.push(`RSI overbought (${rsi.toFixed(2)})`);
    } else if (rsi > rsiMomentumThreshold) {
      momentumScore += 0.5;
      if (!direction) direction = 'bullish';
      signals.push(`RSI bullish (${rsi.toFixed(2)})`);
    }
  }

  // MACD signals
  if (macdEnabled && macd.macd !== null && macd.signal !== null) {
    if (macd.histogram > 0 && macd.macd > macd.signal) {
      momentumScore += 1;
      if (!direction || direction === 'bullish') {
        direction = 'bullish';
      }
      signals.push(`MACD bullish crossover`);
    } else if (macd.histogram < 0 && macd.macd < macd.signal) {
      momentumScore -= 1;
      direction = 'bearish';
      signals.push(`MACD bearish crossover`);
    }
  }

  // Volume confirmation
  if (volumeRatio > volumeMultiplier) {
    momentumScore += 0.5;
    signals.push(`High volume (${volumeRatio.toFixed(2)}x)`);
  }

  // Price momentum (recent price change)
  const priceChange =
    ((close[close.length - 1] - close[close.length - 5]) /
      close[close.length - 5]) *
    100;
  if (Math.abs(priceChange) > 2) {
    if (priceChange > 0) {
      momentumScore += 0.5;
      if (!direction) direction = 'bullish';
      signals.push(`Strong price increase (${priceChange.toFixed(2)}%)`);
    } else {
      momentumScore -= 0.5;
      if (!direction) direction = 'bearish';
      signals.push(`Strong price decrease (${priceChange.toFixed(2)}%)`);
    }
  }

  const strength = Math.abs(momentumScore) / 3; // Normalize to 0-1
  const hasMomentum = momentumScore >= 1.5 && direction === 'bullish';

  return {
    hasMomentum,
    direction,
    strength,
    score: momentumScore,
    signals,
    indicators: {
      rsi: rsi ? rsi.toFixed(2) : null,
      macd: macd.macd ? macd.macd.toFixed(4) : null,
      macdSignal: macd.signal ? macd.signal.toFixed(4) : null,
      macdHistogram: macd.histogram ? macd.histogram.toFixed(4) : null,
      volumeRatio: volumeRatio.toFixed(2),
      priceChange: priceChange.toFixed(2)
    }
  };
};

/**
 * Check if we should exit a momentum trade
 *
 * @param {Object} entryData - Data from when trade was entered
 * @param {Object} currentData - Current market data
 * @param {Object} config - Momentum trading configuration
 * @returns {Object} Exit decision
 */
const shouldExitMomentumTrade = (entryData, currentData, config = {}) => {
  const {
    maxHoldingMinutes = 120,
    minHoldingMinutes = 5,
    profitTarget = 1.5, // percentage
    stopLoss = -1.0, // percentage
    trailingStopPercentage = 0.5
  } = config;

  const { entryPrice, entryTime, highestPrice = entryPrice } = entryData;
  const { currentPrice } = currentData;

  const holdingMinutes = moment().diff(moment(entryTime), 'minutes');
  const profitPercentage = ((currentPrice - entryPrice) / entryPrice) * 100;
  const drawdownFromHigh = ((currentPrice - highestPrice) / highestPrice) * 100;

  const shouldExit = {
    exit: false,
    reason: null,
    profitPercentage
  };

  // Time-based exit
  if (holdingMinutes >= maxHoldingMinutes) {
    shouldExit.exit = true;
    shouldExit.reason = `Maximum holding time reached (${holdingMinutes} minutes)`;
    return shouldExit;
  }

  // Profit target
  if (profitPercentage >= profitTarget && holdingMinutes >= minHoldingMinutes) {
    shouldExit.exit = true;
    shouldExit.reason = `Profit target reached (${profitPercentage.toFixed(
      2
    )}%)`;
    return shouldExit;
  }

  // Stop loss
  if (profitPercentage <= stopLoss) {
    shouldExit.exit = true;
    shouldExit.reason = `Stop loss triggered (${profitPercentage.toFixed(2)}%)`;
    return shouldExit;
  }

  // Trailing stop
  if (
    highestPrice > entryPrice &&
    drawdownFromHigh <= -trailingStopPercentage
  ) {
    shouldExit.exit = true;
    shouldExit.reason = `Trailing stop triggered (${drawdownFromHigh.toFixed(
      2
    )}% from high)`;
    return shouldExit;
  }

  return shouldExit;
};

module.exports = {
  calculateRSI,
  calculateEMA,
  calculateMACD,
  calculateVolumeMomentum,
  detectMomentum,
  shouldExitMomentumTrade
};
