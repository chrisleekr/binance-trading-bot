const { binance } = require('../../../helpers');
/**
 * Cancel order
 *
 * @param {*} logger
 * @param {*} symbol
 * @param {*} order
 */
const cancelOrder = async (logger, symbol, order) => {
  logger.info({ order }, 'Cancelling open orders');
  // Cancel open orders first to make sure it does not have unsettled orders.
  const result = await binance.client.cancelOrder({
    symbol,
    orderId: order.orderId
  });
  logger.info({ result }, 'Cancelled open orders');
};

/**
 * Handle open orders
 *
 * @param {*} logger
 * @param {*} rawData
 */
const execute = async (logger, rawData) => {
  const data = rawData;

  const {
    symbol,
    openOrders,
    buy: { limitPrice: buyLimitPrice },
    sell: { limitPrice: sellLimitPrice }
  } = data;

  openOrders.forEach(async order => {
    if (order.type !== 'STOP_LOSS_LIMIT') {
      return;
    }

    // Is the stop price is higher than current limit price?
    if (order.side.toLowerCase() === 'buy') {
      if (parseFloat(order.stopPrice) >= buyLimitPrice) {
        // Cancel current order
        await cancelOrder(logger, symbol, order);
        // Set action as buy
        data.action = 'buy';
      } else {
        // Set action as buy
        data.action = 'buy-order-wait';
      }
    }

    // Is the stop price is less than current limit price?
    if (order.side.toLowerCase() === 'sell') {
      if (parseFloat(order.stopPrice) <= sellLimitPrice) {
        // Cancel current order
        await cancelOrder(logger, symbol, order);
        // Set action as sell
        data.action = 'sell';
      } else {
        data.action = 'sell-order-wait';
      }
    }
  });

  return data;
};

module.exports = { execute };
