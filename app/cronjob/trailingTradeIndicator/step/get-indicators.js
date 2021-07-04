const _ = require('lodash');
const { binance } = require('../../../helpers');

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
      candles: { interval, limit },
      buy: {
        athRestriction: {
          enabled: buyATHRestrictionEnabled,
          candles: {
            interval: buyATHRestrictionCandlesInterval,
            limit: buyATHRestrictionCandlesLimit
          }
        }
      }
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

  // Get lowest price
  const lowestPrice = _.min(candlesData.low);

  const highestPrice = _.max(candlesData.high);

  // Retrieve ATH candles

  let athPrice = null;

  if (buyATHRestrictionEnabled) {
    logger.info(
      {
        debug: true,
        function: 'athCandles',
        buyATHRestrictionEnabled,
        buyATHRestrictionCandlesInterval,
        buyATHRestrictionCandlesLimit
      },
      'Retrieving ATH candles from API'
    );
    const athCandles = await binance.client.candles({
      symbol,
      interval: buyATHRestrictionCandlesInterval,
      limit: buyATHRestrictionCandlesLimit
    });

    // Flatten candles data to get ATH price
    const athCandlesData = flattenCandlesData(athCandles);

    // ATH (All The High) price
    athPrice = _.max(athCandlesData.high);
  } else {
    logger.info(
      {
        debug: true,
        function: 'athCandles',
        buyATHRestrictionEnabled,
        buyATHRestrictionCandlesInterval,
        buyATHRestrictionCandlesLimit
      },
      'ATH Restriction is disabled'
    );
  }

  logger.info(
    { lowestPrice, highestPrice, athPrice },
    'Retrieved lowest/highest/ath price'
  );

  data.indicators = {
    highestPrice,
    lowestPrice,
    athPrice
  };

  return data;
};

module.exports = { execute };
