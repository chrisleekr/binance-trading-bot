const { cache } = require('../../../helpers');

/**
 * Save data to cache
 *
 * @param {*} logger
 * @param {*} rawData
 */
const execute = async (_logger, rawData) => {
  const data = rawData;

  const { symbol, symbolInfo, indicators, quoteAssetStats } = data;

  cache.hset(
    'trailing-trade-symbols',
    `${symbol}-indicator-data`,
    JSON.stringify(indicators)
  );

  const { quoteAsset } = symbolInfo;

  cache.hset(
    'trailing-trade-quote-stats',
    `${quoteAsset}`,
    JSON.stringify(quoteAssetStats)
  );

  return data;
};

module.exports = { execute };
