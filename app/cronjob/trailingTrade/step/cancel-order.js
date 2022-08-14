const moment = require('moment');
const { binance, slack, PubSub } = require('../../../helpers');
const {
  getAPILimit,
  getAccountInfo,
  getAndCacheOpenOrdersForSymbol
} = require('../../trailingTradeHelper/common');
const { deleteManualOrder } = require('../../trailingTradeHelper/order');

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
    `*${symbol}* Cancel Action:\n` +
      `- Order: \`\`\`${JSON.stringify(order, undefined, 2)}\`\`\``,
    { symbol, apiLimit: getAPILimit(logger) }
  );

  logger.info(
    { function: 'order', orderParams, saveLog: true },
    'The order will be cancelled.'
  );

  const orderResult = await binance.client.cancelOrder(orderParams);

  logger.info({ orderResult, saveLog: true }, 'The order has been cancelled.');

  await deleteManualOrder(logger, symbol, order.orderId);

  // Get open orders and update cache
  data.openOrders = await getAndCacheOpenOrdersForSymbol(logger, symbol);
  data.buy.openOrders = data.openOrders.filter(
    o => o.side.toLowerCase() === 'buy'
  );
  data.sell.openOrders = data.openOrders.filter(
    o => o.side.toLowerCase() === 'sell'
  );

  // Refresh account info
  data.accountInfo = await getAccountInfo(logger);

  PubSub.publish('frontend-notification', {
    type: 'success',
    title:
      `The order for ${symbol} has been cancelled successfully.` +
      ` If the order still display, it should be removed soon.`
  });

  slack.sendMessage(
    `*${symbol}* Cancel Action Result:\n` +
      `- Order Result: \`\`\`${JSON.stringify(
        orderResult,
        undefined,
        2
      )}\`\`\``,
    { symbol, apiLimit: getAPILimit(logger) }
  );

  data.buy.processMessage = `The order has been cancelled.`;
  data.buy.updatedAt = moment().utc().toDate();

  return data;
};

module.exports = { execute };
