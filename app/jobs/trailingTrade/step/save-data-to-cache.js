const { cache } = require('../../../helpers');

/**
 * Save data to cache
 *
 * @param {*} logger
 * @param {*} rawData
 */
const execute = async (logger, rawData) => {
  const data = rawData;

  const { symbol } = data;

  cache.hset('trailing-trade-symbols', `${symbol}-data`, JSON.stringify(data));
  return data;
};

module.exports = { execute };
