const { cache } = require('../../../helpers');

/**
 * Save data to cache
 *
 * @param {*} logger
 * @param {*} rawData
 */
const execute = async (_logger, rawData) => {
  const data = rawData;

  const { symbol, accountInfo, indicators } = data;

  cache.hset(
    'trailing-trade-common',
    `account-info`,
    JSON.stringify(accountInfo)
  );

  cache.hset(
    'trailing-trade-symbols',
    `${symbol}-indicator-data`,
    JSON.stringify(indicators)
  );

  return data;
};

module.exports = { execute };
