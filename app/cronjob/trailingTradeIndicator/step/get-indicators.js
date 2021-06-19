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
  const close = [];

  candles.forEach(candle => {
    openTime.push(+candle.openTime);
    high.push(+candle.high);
    low.push(+candle.low);
    close.push(+candle.close);
  });

  return {
    openTime,
    high,
    low,
    close
  };
};

const huskyTrend = candles => {

  const candleLows = candles.close

  var newCandle = 1;
  var differences = [];
  var difference = 0;
  var status = "not enough data";
  const positiveMultiplier = 1.004;
  const negativeMultiplier = -1.01;

  candleLows.forEach(candle => {
    var newCandleToTest = candleLows[newCandle];
    if (newCandleToTest != undefined) {
      var calc = 0;
      if (candle <= newCandleToTest) {
        calc = (newCandleToTest - candle) * positiveMultiplier;
      } else {
        calc = (candle - newCandleToTest) * negativeMultiplier;
      }

      differences.push(calc);
    }
    newCandle++;
  });

  var lastDiff = 0;
  differences.forEach(diff => {
    difference = (lastDiff + diff).toFixed(6);
  });

  switch (Math.sign(difference)) {
    case -1:
      status = "FALLING";
      break;
    case 0:
      status = "TREND IS TURNING";
      break;
    case 1:
      status = "UP";
      break;
  }

  return { status, difference };
}

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

  const testIndicator = huskyTrend(candlesData);

  // Get lowest price
  const lowestPrice = _.min(candlesData.low);

  const highestPrice = _.max(candlesData.high);
  logger.info({ lowestPrice, highestPrice }, 'Retrieved lowest/highest price');

  data.indicators = {
    highestPrice,
    lowestPrice,
    trend: testIndicator.status,
    trendDiff: testIndicator.difference,
    //  RSI: rsiIndicator
  };

  return data;
};

module.exports = { execute };
