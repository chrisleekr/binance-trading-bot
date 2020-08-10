const tulind = require('tulind');

const bbands = (candlesData, period, stddev) => {
  return tulind.indicators.bbands.indicator([candlesData.close], [period, stddev]);
};

const sma = (candlesData, period) => {
  return tulind.indicators.sma.indicator([candlesData.close], [period]);
};

module.exports = { bbands, sma };
