const moment = require('moment');
const _ = require('lodash');

const { cache, binance } = require('../../../helpers');
const {
  getAndCacheOpenOrdersForSymbol,
  getAccountInfoFromAPI
} = require('../../trailingTradeHelper/common');

/**
 * Retrieve last buy order from cache
 *
 * @param {*} logger
 * @param {*} symbol
 * @returns
 */
const getLastBuyOrder = async (logger, symbol) => {
  const cachedLastBuyOrder =
    JSON.parse(await cache.get(`${symbol}-last-buy-order`)) || {};

  logger.info({ cachedLastBuyOrder }, 'Retrieved last buy order from cache');

  return cachedLastBuyOrder;
};

/**
 * Remove last buy order from cache
 *
 * @param {*} logger
 * @param {*} symbol
 */
const removeLastBuyOrder = async (logger, symbol) => {
  await cache.del(`${symbol}-last-buy-order`);
  logger.info({ debug: true }, 'Deleted last buy order from cache');
};

/**
 * Set buy action and message
 *
 * @param {*} logger
 * @param {*} rawData
 * @param {*} action
 * @param {*} processMessage
 * @returns
 */
const setBuyActionAndMessage = (logger, rawData, action, processMessage) => {
  const data = rawData;

  logger.info({ data }, processMessage);
  data.action = action;
  data.buy.processMessage = processMessage;
  data.buy.updatedAt = moment().utc();
  return data;
};

/**
 * Retrieve last sell order
 *
 * @param {*} logger
 * @param {*} symbol
 * @returns
 */
const getLastSellOrder = async (logger, symbol) => {
  const cachedLastSellOrder =
    JSON.parse(await cache.get(`${symbol}-last-sell-order`)) || {};

  logger.info({ cachedLastSellOrder }, 'Retrieved last sell order from cache');

  return cachedLastSellOrder;
};

/**
 * Is order existing in Binance?
 *
 * @param {*} logger
 * @param {*} lastOrder
 * @returns
 */
const isOrderExistingInBinance = async (logger, lastOrder) => {
  try {
    const order = await binance.client.getOrder({
      symbol: lastOrder.symbol,
      orderId: lastOrder.orderId,
      recvWindow: 10000
    });
    logger.info({ debug: true, order }, 'Order exists in the Binance');
    return _.get(order, 'status', null) !== null;
  } catch (err) {
    logger.info({ debug: true, err }, 'Order does not exist in the Binance');
    return false;
  }
};

/**
 * Remove last sell order from cache
 *
 * @param {*} logger
 * @param {*} symbol
 */
const removeLastSellOrder = async (logger, symbol) => {
  await cache.del(`${symbol}-last-sell-order`);
  logger.info({ debug: true }, 'Deleted last sell order from cache');
};

/**
 * Set sell action and message
 *
 * @param {*} logger
 * @param {*} rawData
 * @param {*} action
 * @param {*} processMessage
 * @returns
 */
const setSellActionAndMessage = (logger, rawData, action, processMessage) => {
  const data = rawData;

  logger.info({ data }, processMessage);
  data.action = action;
  data.sell.processMessage = processMessage;
  data.sell.updatedAt = moment().utc();
  return data;
};

/**
 * Ensure order is placed
 *
 * @param {*} logger
 * @param {*} rawData
 */
const execute = async (logger, rawData) => {
  const data = rawData;

  const { symbol } = data;

  // Ensure buy order placed
  const lastBuyOrder = await getLastBuyOrder(logger, symbol);
  if (_.isEmpty(lastBuyOrder) === false) {
    logger.info({ lastBuyOrder }, 'Last buy order found');

    // If the order exists in the Binance, then
    if (await isOrderExistingInBinance(logger, lastBuyOrder)) {
      logger.info('Order found from binance, remove last buy order');

      // Remove last buy order from cache
      await removeLastBuyOrder(logger, symbol);

      // Refresh open orders
      data.openOrders = await getAndCacheOpenOrdersForSymbol(logger, symbol);

      data.buy.openOrders = data.openOrders.filter(
        o => o.side.toLowerCase() === 'buy'
      );

      // Get account info
      data.accountInfo = await getAccountInfoFromAPI(logger);
    } else {
      // If the order does not exist in the Binance, then wait for appearing.
      return setBuyActionAndMessage(
        logger,
        data,
        'buy-order-checking',
        'The buy order seems placed; however, cannot find from Binance. ' +
          'Wait for the buy order to appear in the Binance.'
      );
    }
  }

  // Ensure sell order placed
  const lastSellOrder = await getLastSellOrder(logger, symbol);
  if (_.isEmpty(lastSellOrder) === false) {
    logger.info({ lastSellOrder }, 'Last sell order found');

    // If the order exists in the Binance, then
    if (await isOrderExistingInBinance(logger, lastSellOrder)) {
      logger.info('Order found from binance, remove last sell order');

      // Remove last buy order from cache
      await removeLastSellOrder(logger, symbol);

      // Refresh open orders
      data.openOrders = await getAndCacheOpenOrdersForSymbol(logger, symbol);

      data.sell.openOrders = data.openOrders.filter(
        o => o.side.toLowerCase() === 'sell'
      );

      // Get account info
      data.accountInfo = await getAccountInfoFromAPI(logger);
    } else {
      // If the order does not exist in the Binance, then wait for appearing.
      // If the order does not exist in the Binance, then wait for appearing.
      return setSellActionAndMessage(
        logger,
        data,
        'sell-order-checking',
        'The sell order seems placed; however, cannot find from Binance. ' +
          'Wait for the sell order to appear in the Binance.'
      );
    }
  }

  return data;
};

module.exports = { execute };
