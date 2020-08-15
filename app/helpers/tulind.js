const tulind = require('tulind');

const bbands = (candlesData, period, stddev) => {
  return tulind.indicators.bbands.indicator([candlesData.close], [period, stddev]);
};

const sma = (candlesData, period) => {
  return tulind.indicators.sma.indicator([candlesData.close], [period]);
};

const macd = (candlesData, shortPeriod, longPeriod, signalPeriod) => {
  return tulind.indicators.macd.indicator([candlesData.close], [shortPeriod, longPeriod, signalPeriod]);
};

module.exports = { bbands, sma, macd };
