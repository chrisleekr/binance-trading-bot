const _ = require('lodash');
const { binance, mongo } = require('../../../helpers');

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
    { function: 'candles', interval, limit },
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

  // Fetch and store candles for momentum trading if enabled
  const momentumConfig = data.symbolConfiguration?.momentum;
  if (momentumConfig && momentumConfig.enabled) {
    const timeframes = momentumConfig.timeframes || ['15m', '1h'];

    logger.info(
      { timeframes },
      'Momentum trading enabled, fetching candles for additional timeframes'
    );

    // eslint-disable-next-line no-restricted-syntax
    await Promise.all(
      timeframes.map(async timeframe => {
        try {
          logger.info(
            { timeframe, limit: 100 },
            `Fetching ${timeframe} candles for momentum analysis`
          );

          const momentumCandles = await binance.client.candles({
            symbol,
            interval: timeframe,
            limit: 100
          });

          // Store candles in MongoDB for momentum analysis
          await mongo.deleteAll(logger, 'trailing-trade-candles', {
            key: `${symbol}-${timeframe}`
          });

          const candlesToStore = momentumCandles.map(candle => ({
            key: `${symbol}-${timeframe}`,
            symbol,
            interval: timeframe,
            openTime: candle.openTime,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume: candle.volume,
            closeTime: candle.closeTime
          }));

          await mongo.insertMany(
            logger,
            'trailing-trade-candles',
            candlesToStore
          );

          logger.info(
            { timeframe, count: candlesToStore.length },
            `Stored ${timeframe} candles for momentum analysis`
          );
        } catch (error) {
          logger.error(
            { error, timeframe },
            `Failed to fetch/store ${timeframe} candles for momentum`
          );
        }
      })
    );
  }

  return data;
};

module.exports = { execute };
