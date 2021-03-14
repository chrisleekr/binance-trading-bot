const { binance } = require('../../../helpers');

/**
 * Get open orders
 *
 * @param {*} logger
 * @param {*} symbol
 */
const getOpenOrders = async (logger, symbol) => {
  const openOrders = await binance.client.openOrders({
    symbol,
    recvWindow: 10000
  });
  logger.info({ openOrders }, 'Get open orders');

  return openOrders;
};

/**
 * Get open orders
 *
 * @param {*} logger
 * @param {*} rawData
 */
const execute = async (logger, rawData) => {
  const data = rawData;

  const { symbol } = data;

  const openOrders = await getOpenOrders(logger, symbol);

  data.openOrders = openOrders;

  return data;
};

module.exports = { execute };
