/* eslint-disable prefer-destructuring */
const _ = require('lodash');
const { binance } = require('../../../helpers');

/**
 * Flatten candle data
 *
 * @param {*} candles
 */
const flattenCandlesData = candles => {
  const openTime = [];
  const low = [];

  candles.forEach(candle => {
    openTime.push(+candle.openTime);
    low.push(+candle.low);
  });

  return {
    openTime,
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
    { debug: true, function: 'candles' },
    'Retrieving candles from API'
  );
  const candles = await binance.client.candles({
    symbol,
    interval,
    limit
  });

  // Flatten candles data to get lowest price
  const candlesData = flattenCandlesData(candles);

  // Get lowest price
  const lowestPrice = _.min(candlesData.low);
  logger.info({ lowestPrice }, 'Retrieved lowest price');

  data.indicators = {
    lowestPrice
  };

  return data;
};

module.exports = { execute };
