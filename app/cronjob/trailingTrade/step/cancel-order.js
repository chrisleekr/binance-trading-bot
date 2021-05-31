const moment = require('moment');
const { binance, slack, cache, PubSub } = require('../../../helpers');
const {
  getAPILimit,
  getAndCacheOpenOrdersForSymbol,
  getAccountInfoFromAPI
} = require('../../trailingTradeHelper/common');

/**
 * Cancel order
 *
 * @param {*} logger
 * @param {*} rawData
 */
const execute = async (logger, rawData) => {
  const data = rawData;
  const { symbol, isLocked, action, order } = data;

  if (isLocked) {
    logger.info({ isLocked }, 'Symbol is locked, do not process cancel-order');
    return data;
  }

  if (action !== 'cancel-order') {
    logger.info(
      `Do not process a cancel order because action is not 'cancel-order'.`
    );
    return data;
  }

  // Assume order is provided with correct value
  const orderParams = {
    symbol,
    orderId: order.orderId
  };

  slack.sendMessage(
    `${symbol} Cancel Action (${moment().format('HH:mm:ss.SSS')}): \n` +
      `- Order: \`\`\`${JSON.stringify(order, undefined, 2)}\`\`\`\n` +
      `- Current API Usage: ${getAPILimit(logger)}`
  );

  logger.info(
    { debug: true, function: 'order', orderParams },
    'Cancel order params'
  );

  const orderResult = await binance.client.cancelOrder(orderParams);

  logger.info({ orderResult }, 'Cancelling order result');

  await cache.hdel(`trailing-trade-manual-buy-order-${symbol}`, order.orderId);

  // Get open orders and update cache
  data.openOrders = await getAndCacheOpenOrdersForSymbol(logger, symbol);
  data.buy.openOrders = data.openOrders.filter(
    o => o.side.toLowerCase() === 'buy'
  );
  data.sell.openOrders = data.openOrders.filter(
    o => o.side.toLowerCase() === 'sell'
  );

  // Refresh account info
  data.accountInfo = await getAccountInfoFromAPI(logger);

  PubSub.publish('frontend-notification', {
    type: 'success',
    title:
      `The order for ${symbol} has been cancelled successfully.` +
      ` If the order still display, it should be removed soon.`
  });

  slack.sendMessage(
    `${symbol} Cancel Action Result (${moment().format('HH:mm:ss.SSS')}):\n` +
      `- Order Result: \`\`\`${JSON.stringify(
        orderResult,
        undefined,
        2
      )}\`\`\`\n` +
      `- Current API Usage: ${getAPILimit(logger)}`
  );

  data.buy.processMessage = `The order has been cancelled.`;
  data.buy.updatedAt = moment().utc();

  return data;
};

module.exports = { execute };
