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
      candles: { interval, limit }, isGoingUp
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
  var difference = 0.000;
  candleLows.forEach(candle => {
    var newCandleToTest = candleLows[newCandle];
    if (newCandleToTest != undefined) {
      if (candle >= newCandleToTest) {
      calc = candle - newCandleToTest;
      difference = calc;
      messenger.errorMessage("going up");
    } else {
      calc = newCandleToTest - candle;
      difference = calc;
      messenger.errorMessage("going down");
    }
    }
    newCandle++;
  });
  messenger.errorMessage("Diff: " + difference);

  if (Math.sign(difference) == 1) {
    messenger.errorMessage("going up");
    isGoingUp.itIs = "up";
  } else if (Math.sign(difference) == 0) {
    messenger.errorMessage("maintaining");
    isGoingUp.itIs = "maintaining position";
  } else if (Math.sign(difference) == -1) {
    messenger.errorMessage("falling");
    isGoingUp.itIs = "falling";
  } else if (Math.sign(difference) == -0) {
    messenger.errorMessage("xupa kuu")
  }
  // Get lowest price
  const lowestPrice = _.min(candlesData.low);

  const highestPrice = _.max(candlesData.high);
  logger.info({ lowestPrice, highestPrice }, 'Retrieved lowest/highest price');

  data.indicators = {
    highestPrice,
    lowestPrice
  };

  return data;
};

module.exports = { execute };
