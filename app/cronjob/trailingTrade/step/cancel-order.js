const moment = require('moment');
const { binance, slack, PubSub } = require('../../../helpers');
const {
  getAPILimit,
  getAndCacheOpenOrdersForSymbol,
  getAccountInfoFromAPI
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
  const { symbol, action, order } = data;

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

  const { side } = order;
  logger.info(
    { function: 'order', orderParams, saveLog: true },
    `The ${side.toLowerCase()} order will be cancelled.`
  );

  const orderResult = await binance.client.cancelOrder(orderParams);

  logger.info(
    { orderResult, saveLog: true },
    `The ${side.toLowerCase()} order has been cancelled.`
  );

  await deleteManualOrder(logger, symbol, order.orderId);

  // FIXME: If you change this comment, please refactor to use common.js:refreshOpenOrdersAndAccountInfo
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
      `The ${side.toLowerCase()} order for ${symbol} has been cancelled successfully.` +
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

  data.buy.processMessage = `The ${side.toLowerCase()} order has been cancelled.`;
  data.buy.updatedAt = moment().utc().toDate();

  return data;
};

module.exports = { execute };
