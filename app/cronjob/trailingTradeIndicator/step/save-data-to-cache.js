const { cache } = require('../../../helpers');

/**
 * Save data to cache
 *
 * @param {*} _logger
 * @param {*} rawData
 */
const execute = async (_logger, rawData) => {
  const data = rawData;

  const { symbolInfo, closedTrades } = data;

  const { quoteAsset } = symbolInfo;

  cache.hset(
    'trailing-trade-closed-trades',
    `${quoteAsset}`,
    JSON.stringify(closedTrades)
  );

  return data;
};

module.exports = { execute };
