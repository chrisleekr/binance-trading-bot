const config = require('config');
const moment = require('moment');
const _ = require('lodash');

const {
  cache,
  messenger,
  binance,
  PubSub,
  mongo
} = require('../../../helpers');
const {
  getAndCacheOpenOrdersForSymbol,
  getAccountInfoFromAPI,
  disableAction,
  getLastBuyPrice,
  saveLastBuyPrice
} = require('../../trailingTradeHelper/common');

/**
 * Remove last buy order from cache
 *
 * @param {*} logger
 * @param {*} symbol
 */
const removeLastBuyOrder = async (logger, symbol, orderResult = undefined) => {
  try {
    if (orderResult !== undefined) {
      await calculateLastBuyPrice(logger, symbol, orderResult);
    }
    await cache.del(`${symbol}-last-buy-order`);
    logger.info({ debug: true }, 'Deleted last buy order from cache');
  } catch (error) {}
};

/**
 * Retrieve last buy price and recalculate new last buy price
 *
 * @param {*} logger
 * @param {*} symbol
 * @param {*} order
 */
const lastAddedOrder = {
  price: 0,
  qty: 0
};
const calculateLastBuyPrice = async (logger, symbol, order) => {
  let orderPrice = parseFloat(order.price);
  const { origQty } = order;
  if (orderPrice === 0) {
    const { cummulativeQuoteQty } = order;
    orderPrice = cummulativeQuoteQty / origQty;
  }
  const lastBuyPriceDoc = await getLastBuyPrice(logger, symbol);
  const orgLastBuyPrice = _.get(lastBuyPriceDoc, 'lastBuyPrice', 0);
  const orgQuantity = _.get(lastBuyPriceDoc, 'quantity', 0);
  const orgTotalAmount = orgLastBuyPrice * orgQuantity;

  let newQuantity = origQty;
  let newTotalAmount = orderPrice;
  let newLastBuyPrice = newTotalAmount;

  logger.info(
    { orgLastBuyPrice, orgQuantity, orgTotalAmount },
    'Existing last buy price'
  );

  if (lastAddedOrder.price !== orderPrice && lastAddedOrder.qty !== origQty) {
    const filledQuoteQty = parseFloat(orderPrice);
    const filledQuantity = parseFloat(origQty);
    const filledAmount = filledQuoteQty * filledQuantity;

    newQuantity = orgQuantity + filledQuantity;
    newTotalAmount = orgTotalAmount + filledAmount;

    newLastBuyPrice = newTotalAmount / newQuantity;

    logger.info(
      { newLastBuyPrice, newTotalAmount, newQuantity },
      'New last buy price'
    );

    lastAddedOrder.price = orderPrice;
    lastAddedOrder.qty = origQty;
  }
  await saveLastBuyPrice(logger, symbol, {
    lastBuyPrice: newLastBuyPrice,
    quantity: newQuantity,
    lastBoughtPrice: parseFloat(orderPrice)
  });

  PubSub.publish('frontend-notification', {
    type: 'success',
    title: `New last buy price for ${symbol} has been updated.`
  });
};

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
 *Sanitize past trades (removing duplicates)
 * @param {*} symbol
 * @param {*} oldOrder
 */
const sanitizePastTrades = async pastTrades => {
  let i = 1;
  pastTrades.forEach(trade => {
    if (i < pastTrades.length) {
      const oldDate = trade.date;
      const newDate = pastTrades[i].date;
      const oldSymbol = trade.symbol;
      const newSymbol = pastTrades[i].symbol;
      if ((new Date(newDate) - new Date(oldDate)) / 1000 < 3 && oldSymbol === newSymbol) {
        if (i > -1) {
          pastTrades.splice(i, 1);
        }
      }
    }
    i += 1;
  });

  return pastTrades;
};

/**
 * Add to past Trades
 *
 * @param {*} logger
 * @param {*} symbol
 */
const addPastTrade = async (symbol, oldOrder) => {
  const cachedTrades = JSON.parse(await cache.get(`past-trades`)) || [];

  const { finalProfit, finalProfitPercent } = oldOrder;

  const trade = {
    symbol,
    profit: parseFloat(finalProfit.toFixed(7)),
    percent: parseFloat(finalProfitPercent.toFixed(2)),
    date: new Date().toLocaleString()
  };

  cachedTrades.push(trade);

  messenger.errorMessage(`Cached trades: ${JSON.stringify(cachedTrades)}`);

  const sanitizedTrades = await sanitizePastTrades(cachedTrades);

  await cache.set(`past-trades`, JSON.stringify(sanitizedTrades));
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
 * Remove last sell order from cache
 *
 * @param {*} logger
 * @param {*} symbol
 */
const removeLastSellOrder = async (logger, symbol) => {
  try {
    await cache.del(`${symbol}-last-sell-order`);

    logger.info({ debug: true }, 'Deleted last sell order from cache');
    return true;
  } catch (error) {
    return false;
  }
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
 * Check whether the order existing in the open orders
 *
 * @param {*} _logger
 * @param {*} order
 * @param {*} openOrders
 * @returns
 */
const isOrderExistingInOpenOrders = (_logger, order, openOrders) =>
  _.findIndex(openOrders, o => o.orderId === order.orderId) !== -1;

/**
 * Ensure order is placed
 *
 * @param {*} logger
 * @param {*} rawData
 */
let lastBuyCheck = '';
let lastSellCheck = '';
const execute = async (logger, rawData) => {
  const data = rawData;

  const { symbol, action, featureToggle } = data;

  if (action !== 'not-determined') {
    logger.info(
      { action },
      'Action is already defined, do not try to ensure order placed.'
    );
    return data;
  }

  // Ensure buy order placed
  const lastBuyOrder = await getLastBuyOrder(logger, symbol);
  if (_.isEmpty(lastBuyOrder) === false) {
    const difference = (new Date() - lastBuyCheck) / 1000;
    if (difference > 2.5 || lastBuyCheck === '') {
      logger.info({ debug: true, lastBuyOrder }, 'Last buy order found');

      // Refresh open orders
      const openOrders = await getAndCacheOpenOrdersForSymbol(logger, symbol);

      // Assume open order is not executed, make sure the order is in the open orders.
      // If executed that is ok, after some seconds later, the cached last order will be expired anyway and sell.
      if (isOrderExistingInOpenOrders(logger, lastBuyOrder, openOrders)) {
        logger.info(
          { debug: true },
          'Order is existing in the open orders. All good, remove last buy order.'
        );

        data.openOrders = openOrders;

        data.buy.openOrders = data.openOrders.filter(
          o => o.side.toLowerCase() === 'buy'
        );

        // Get account info
        data.accountInfo = await getAccountInfoFromAPI(logger);

        /*  // Lock symbol action 20 seconds to avoid API limit
        await disableAction(
          symbol,
          {
            disabledBy: 'buy order',
            message: 'Disabled action after confirming the buy order.',
            canResume: false,
            canRemoveLastBuyPrice: false
          },
          1
        );
        */
      } else {
        const removeStatuses = [
          'CANCELED',
          'REJECTED',
          'EXPIRED',
          'PENDING_CANCEL'
        ];
        let orderResult = {};
        try {
          orderResult = await binance.client.getOrder({
            symbol,
            orderId: lastBuyOrder.orderId
          });
        } catch (e) {
          logger.error(
            { e },
            'The order could not be found or error occurred querying the order.'
          );
          // If order is no longer available, then delete from cache
          await removeLastBuyOrder(logger, symbol);
          messenger.errorMessage(`Removed order by this error: ${e}`);
        }

        if (orderResult !== {}) {
          // If filled, then calculate average cost and quantity and save new last buy price.
          if (orderResult.status === 'FILLED') {
            logger.info(
              { lastBuyOrder },
              'The order is filled, calculate last buy price.'
            );

            // If order is no longer available, then delete from cache
            await removeLastBuyOrder(logger, symbol, orderResult);

            if (_.get(featureToggle, 'notifyOrderConfirm', false) === true) {
              messenger.sendMessage(symbol, lastBuyOrder, 'BUY_CONFIRMED');
            }

            // Lock symbol action 20 seconds to avoid API limit
            await disableAction(
              symbol,
              {
                disabledBy: 'buy order filled',
                message: 'Disabled action after confirming the buy order.',
                canResume: false,
                canRemoveLastBuyPrice: false
              },
              5
            );

            return setBuyActionAndMessage(
              logger,
              data,
              'buy-order-filled',
              'The buy order was filled.'
            );
          }
          if (removeStatuses.includes(orderResult.status) === true) {
            // If order is no longer available, then delete from cache
            await removeLastBuyOrder(logger, symbol);
          }
        }

        logger.info(
          { debug: true },
          'Order does not exist in the open orders. Wait until it appears.'
        );

        if (_.get(featureToggle, 'notifyOrderConfirm', false) === true) {
          messenger.sendMessage(symbol, lastBuyOrder, 'BUY_NOT_FOUND');
        }

        return setBuyActionAndMessage(
          logger,
          data,
          'buy-order-checking',
          'The buy order seems placed; however, it does not appear in the open orders. ' +
            'Wait for the buy order to appear in open orders.'
        );
      }
      lastBuyCheck = new Date();
    }
  }

  // Ensure sell order placed
  const lastSellOrder = await getLastSellOrder(logger, symbol);
  if (_.isEmpty(lastSellOrder) === false) {
    const difference = (new Date() - lastSellCheck) / 1000;
    if (difference > 2.5 || lastSellCheck === '') {
      logger.info({ debug: true, lastSellOrder }, 'Last sell order found');

      // Refresh open orders
      const openOrders = await getAndCacheOpenOrdersForSymbol(logger, symbol);

      // Assume open order is not executed, make sure the order is in the open orders.
      // If executed that is ok, after some seconds later, the cached last order will be expired anyway and sell.
      if (isOrderExistingInOpenOrders(logger, lastSellOrder, openOrders)) {
        logger.info(
          { debug: true },
          'Order is existing in the open orders. All good, remove last sell order.'
        );

        data.openOrders = openOrders;

        data.sell.openOrders = data.openOrders.filter(
          o => o.side.toLowerCase() === 'sell'
        );

        // Get account info
        data.accountInfo = await getAccountInfoFromAPI(logger);

        // Lock symbol action 20 seconds to avoid API limit
        await disableAction(
          symbol,
          {
            disabledBy: 'sell order',
            message: 'Disabled action after confirming the sell order.',
            canResume: false,
            canRemoveLastBuyPrice: false
          },
          2
        );
      } else {
        const removeStatuses = [
          'CANCELED',
          'REJECTED',
          'EXPIRED',
          'PENDING_CANCEL'
        ];
        let orderResult;
        try {
          orderResult = await binance.client.getOrder({
            symbol,
            orderId: lastSellOrder.orderId
          });
        } catch (e) {
          logger.error(
            { e },
            'The order could not be found or error occurred querying the order.'
          );
          // If order is no longer available, then delete from cache
          await removeLastSellOrder(logger, symbol);
          messenger.errorMessage(`Removed sell order by this error: ${e}`);
        }

        // If filled, then calculate average cost and quantity and save new last buy price.
        if (orderResult.status === 'FILLED') {
          logger.info(
            { lastSellOrder },
            'The order is filled, calculate last buy price.'
          );

          // Save past trade
          await addPastTrade(symbol, lastSellOrder);

          // If order is no longer available, then delete from cache
          await removeLastSellOrder(logger, symbol, lastSellOrder);

          // Remove last buy price
          await mongo.deleteOne(logger, 'trailing-trade-symbols', {
            key: `${symbol}-last-buy-price`
          });

          if (_.get(featureToggle, 'notifyOrderConfirm', false) === true) {
            messenger.sendMessage(symbol, lastBuyOrder, 'SELL_CONFIRMED');
          }

          // Lock symbol action 20 seconds to avoid API limit
          await disableAction(
            symbol,
            {
              disabledBy: 'sell order filled',
              message: 'Disabled action after selling.',
              canResume: false,
              canRemoveLastBuyPrice: false
            },
            5
          );

          return setSellActionAndMessage(
            logger,
            data,
            'sell-order-filled',
            'The sell order was filled.'
          );
        }
        if (removeStatuses.includes(orderResult.status) === true) {
          // If order is no longer available, then delete from cache
          await removeLastSellOrder(logger, symbol);
        }

        logger.info(
          { debug: true },
          'Order does not exist in the open orders. Wait until it appears.'
        );

        if (_.get(featureToggle, 'notifyOrderConfirm', false) === true) {
          messenger.sendMessage(symbol, lastBuyOrder, 'SELL_NOT_FOUND');
        }

        return setSellActionAndMessage(
          logger,
          data,
          'sell-order-checking',
          'The sell order seems placed; however, it does not appear in the open orders. ' +
            'Wait for the sell order to appear in open orders.'
        );
      }
      lastSellCheck = new Date();
    }
  }

  return data;
};

module.exports = { execute };
