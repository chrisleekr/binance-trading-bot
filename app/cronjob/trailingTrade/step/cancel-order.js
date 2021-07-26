const moment = require('moment');
const config = require('config');
const { binance, messenger, cache, PubSub } = require('../../../helpers');
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


  const language = config.get('language');
  const { coin_wrapper: { _actions } } = require(`../../../../public/${language}.json`);

  logger.info(
    { debug: true, function: 'order', orderParams },
    'Cancel order params'
  );

  const orderResult = await binance.client.cancelOrder(orderParams);

  logger.info({ orderResult }, 'Cancelling order result');

  await cache.hdel(`trailing-trade-manual-buy-order-${symbol}`, order.orderId);

  messenger.errorMessage("Order cancelled, result: " + JSON.stringify(orderResult))

  // Get open orders and update cache
  data.openOrder = await getAndCacheOpenOrdersForSymbol(logger, symbol);
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
      _actions.action_cancel_success[1] + symbol + _actions.action_cancel_success[2]
  });

  messenger.sendMessage(
    symbol, orderResult, 'ORDER_CANCELED'
  );



 /* const cachedLastBuyOrder =
     JSON.parse(await cache.hget(`${symbol}-last-buy-order`)) || {};
   if (!_.isEmpty(cachedLastBuyOrder)) {
    await cache.hdel(`${symbol}-last-buy-order`);
   }
*/
  const cachedLastSellOrder =
    JSON.parse(await cache.get(`${symbol}-last-sell-order`)) || {};
  if (!_.isEmpty(cachedLastSellOrder)) {
    await cache.del(`${symbol}-last-sell-order`);
  }

  data.buy.processMessage = _actions.order_cancelled;
  data.buy.updatedAt = moment().utc();

  return data;
};

module.exports = { execute };
