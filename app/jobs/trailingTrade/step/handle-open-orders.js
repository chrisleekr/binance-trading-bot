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
 *
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

  // eslint-disable-next-line no-restricted-syntax
  for (const order of openOrders) {
    if (order.type !== 'STOP_LOSS_LIMIT') {
      // eslint-disable-next-line no-continue
      continue;
    }
    // Is the stop price is higher than current limit price?
    if (order.side.toLowerCase() === 'buy') {
      if (parseFloat(order.stopPrice) >= buyLimitPrice) {
        logger.info(
          { stopPrice: order.stopPrice, buyLimitPrice },
          'Stop price is higher than buy limit price, cancel current buy order'
        );
        // Cancel current order
        // eslint-disable-next-line no-await-in-loop
        await cancelOrder(logger, symbol, order);

        // Reset buy open orders
        data.buy.openOrders = [];

        // Set action as buy
        data.action = 'buy';

        // Set refreshAccountInfo indicator to retrieve new balance
        data.refreshAccountInfo = true;
      } else {
        logger.info(
          { stopPrice: order.stopPrice, buyLimitPrice },
          'Stop price is less than buy limit price, wait for buy order'
        );
        // Set action as buy
        data.action = 'buy-order-wait';
      }
    }

    // Is the stop price is less than current limit price?
    if (order.side.toLowerCase() === 'sell') {
      if (parseFloat(order.stopPrice) <= sellLimitPrice) {
        logger.info(
          { stopPrice: order.stopPrice, sellLimitPrice },
          'Stop price is less than sell limit price, cancel current sell order'
        );

        // Cancel current order
        // eslint-disable-next-line no-await-in-loop
        await cancelOrder(logger, symbol, order);

        // Reset sell open orders
        data.sell.openOrders = [];

        // Set action as sell
        data.action = 'sell';

        // Set refreshAccountInfo indicator to retrieve new balance
        data.refreshAccountInfo = true;
      } else {
        logger.info(
          { stopPrice: order.stopPrice, sellLimitPrice },
          'Stop price is higher than sell limit price, wait for sell order'
        );
        data.action = 'sell-order-wait';
      }
    }
    logger.info({ action: data.action }, 'Determined action');
  }

  return data;
};

module.exports = { execute };
