const { cache } = require('../../../helpers');

/*
 *
 * Get open orders
 *
 * @param {*} logger
 * @param {*} rawData
 */
const execute = async (logger, rawData) => {
  const data = rawData;

  const { symbol } = data;

  data.openOrders =
    JSON.parse(await cache.hget('trailing-trade-orders', symbol)) || [];

  logger.info({ openOrders: data.openOrders }, 'Retrieved open orders');

  return data;
};

module.exports = { execute };
