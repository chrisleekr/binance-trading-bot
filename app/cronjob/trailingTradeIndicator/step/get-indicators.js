const _ = require('lodash');
const { binance, messenger } = require('../../../helpers');

/**
 * Flatten candle data
 *
 * @param {*} candles
 */
const flattenCandlesData = candles => {
  const openTime = [];
  const high = [];
  const low = [];

  candles.forEach(candle => {
    openTime.push(+candle.openTime);
    high.push(+candle.high);
    low.push(+candle.low);
  });

  return {
    openTime,
    high,
    low
  };
};

/**
 * Get symbol information, buy/sell indicators
 *
 * @param {*} logger
 * @param {*} rawData
 */
const execute = async (logger, rawData) => {
  const data = rawData;

  const {
    symbol,
    symbolConfiguration: {
      candles: { interval, limit }
    }
  } = data;

  // Retrieve candles
  logger.info(
    { debug: true, function: 'candles', interval, limit },
    'Retrieving candles from API'
  );
  const candles = await binance.client.candles({
    symbol,
    interval,
    limit
  });

  // Flatten candles data to get lowest price
  const candlesData = flattenCandlesData(candles);
  const candleLows = candlesData.low

  var newCandle = 1;
  var differences = [];
  var difference = 0;
  var status = "not enough data";

  candleLows.forEach(candle => {
    var newCandleToTest = candleLows[newCandle];
    if (newCandleToTest != undefined) {
      if (candle <= newCandleToTest) {
        calc = (newCandleToTest - candle).toFixed(5) * 1;
      } else {
        calc = (candle - newCandleToTest).toFixed(5) * -1;
      }

      differences.push(calc);
    }
    newCandle++;
  });

  var lastDiff = 0;
  differences.forEach(diff => {
    difference = lastDiff + diff;
  });

  switch (Math.sign(difference)) {
    case -1:
      status = "FALLING";
      break;
    case 0:
      status = "HOLDING";
      break;
    case 1:
      status = "UP";
      break;
  }

  // Get lowest price
  const lowestPrice = _.min(candlesData.low);

  const highestPrice = _.max(candlesData.high);
  logger.info({ lowestPrice, highestPrice }, 'Retrieved lowest/highest price');

  data.indicators = {
    highestPrice,
    lowestPrice,
    trend: status,
    trendDiff: difference
  };

  return data;
};

module.exports = { execute };
