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

const testIndicatorData = candles => {

  const candleLows = candles.close

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

  return { status, difference };
}

const rsiData = candles => {
  var totalU = 0;
  var totalD = 0;
  var startU = candles.high.length - 15;
  var endU = candles.high.length;
  var startD = candles.low.length - 15;
  var endD = candles.low.length;
  for (var i = 0; i < endU; i++) {
    if (i >= startU) {
      totalU += candles.high[i];
    }
  }
  for (var i = 0; i < endD; i++) {
    if (i >= startD) {
      totalD += candles.low[i];
    }
  }
  const avgU = totalU / candles.high.length;
  const avgD = totalD / candles.low.length;

  const RS = avgU / avgD;
  const RSI = 100 - 100 / (1 + RS);
  return RSI;
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

  const testIndicator = testIndicatorData(candlesData);
  const rsiIndicator = rsiData(candlesData);

  // Get lowest price
  const lowestPrice = _.min(candlesData.low);

  const highestPrice = _.max(candlesData.high);
  logger.info({ lowestPrice, highestPrice }, 'Retrieved lowest/highest price');

  data.indicators = {
    highestPrice,
    lowestPrice,
    trend: testIndicator.status,
    trendDiff: testIndicator.difference,
    RSI: rsiIndicator
  };

  return data;
};

module.exports = { execute };
