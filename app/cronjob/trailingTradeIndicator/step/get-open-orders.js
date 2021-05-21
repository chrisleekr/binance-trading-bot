const {
  getAndCacheOpenOrdersForSymbol
} = require('../../trailingTradeHelper/common');

/**
 * Get open orders
 *
 * @param {*} logger
 * @param {*} rawData
 */
const execute = async (logger, rawData) => {
  const data = rawData;

  const { symbol } = rawData;

  // Calling `open-orders` without symbol cost 40 weight for API.
  // However, if you call `open-orders` with symbol, it only cost 1 weight for API.
  // To avoid exceeding API limit, retrieve open orders for each symbol per second.
  // When there is new order placed by the bot, it will update immediately after placing the order.

  data.openOrders = await getAndCacheOpenOrdersForSymbol(logger, symbol);

  return data;
};

module.exports = { execute };
