const tulind = require('tulind');

/**
 * Retrieve Bollinger Band
 *
 * @param {*} candlesData
 * @param {*} period
 * @param {*} stddev
 */
const bbands = (candlesData, period, stddev) => {
  return tulind.indicators.bbands.indicator([candlesData.close], [period, stddev]);
};

/**
 * Retrieve Simple Moving Average
 * @param {*} candlesData
 * @param {*} period
 */
const sma = (candlesData, period) => {
  return tulind.indicators.sma.indicator([candlesData.close], [period]);
};

/**
 * Retrieve Moving Average Convergence/Divergence
 *
 * @param {*} candlesData
 * @param {*} shortPeriod
 * @param {*} longPeriod
 * @param {*} signalPeriod
 */
const macd = (candlesData, shortPeriod, longPeriod, signalPeriod) => {
  return tulind.indicators.macd.indicator([candlesData.close], [shortPeriod, longPeriod, signalPeriod]);
};

module.exports = { bbands, sma, macd };
