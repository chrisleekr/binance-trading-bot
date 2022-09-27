/* eslint-disable no-await-in-loop */
const moment = require('moment');

const {
  cancelOrder,
  saveOverrideAction,
  isExceedingMaxOpenTrades,
  refreshOpenOrdersAndAccountInfo,
  getAccountInfoFromAPI
} = require('../../trailingTradeHelper/common');

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
    action,
    isLocked,
    openOrders,
    buy: { limitPrice: buyLimitPrice },
    sell: { limitPrice: sellLimitPrice }
  } = data;

  if (isLocked) {
    logger.info(
      { isLocked },
      'Symbol is locked, do not process handle-open-orders'
    );
    return data;
  }

  if (action !== 'not-determined') {
    logger.info(
      { action },
      'Action is already defined, do not try to handle open orders.'
    );
    return data;
  }

  // eslint-disable-next-line no-restricted-syntax
  for (const order of openOrders) {
    if (order.type !== 'STOP_LOSS_LIMIT') {
      // eslint-disable-next-line no-continue
      continue;
    }

    // Process buy order
    if (order.side.toLowerCase() === 'buy') {
      if (await isExceedingMaxOpenTrades(logger, data)) {
        // Cancel the initial buy order if max. open trades exceeded
        data.action = 'buy-order-cancelled';
        logger.info(
          { data, saveLog: true },
          `The current number of open trades has reached the maximum number of open trades. ` +
            `The buy order will be cancelled.`
        );

        // Cancel current order
        const cancelResult = await cancelOrder(logger, symbol, order);

        // Reset buy open orders
        if (cancelResult === false) {
          const {
            accountInfo,
            openOrders: updatedOpenOrders,
            buyOpenOrders
          } = await refreshOpenOrdersAndAccountInfo(logger, symbol);

          data.accountInfo = accountInfo;
          data.openOrders = updatedOpenOrders;
          data.buy.openOrders = buyOpenOrders;

          data.action = 'buy-order-checking';
        } else {
          data.buy.openOrders = [];

          data.accountInfo = await getAccountInfoFromAPI(logger);
        }
      } else if (parseFloat(order.stopPrice) >= buyLimitPrice) {
        // Is the stop price is higher than current limit price?
        logger.info(
          { stopPrice: order.stopPrice, buyLimitPrice, saveLog: true },
          'Stop price is higher than buy limit price, cancel current buy order'
        );

        // Cancel current order
        const cancelResult = await cancelOrder(logger, symbol, order);
        if (cancelResult === false) {
          // If cancelling the order is failed, it means the order may already be executed or does not exist anymore.
          // Hence, refresh the order and process again in the next tick.
          // Get open orders and update cache
          const {
            accountInfo,
            openOrders: updatedOpenOrders,
            buyOpenOrders
          } = await refreshOpenOrdersAndAccountInfo(logger, symbol);

          data.accountInfo = accountInfo;
          data.openOrders = updatedOpenOrders;
          data.buy.openOrders = buyOpenOrders;

          data.action = 'buy-order-checking';

          await saveOverrideAction(
            logger,
            symbol,
            {
              action: 'buy',
              actionAt: moment().toISOString(),
              triggeredBy: 'buy-cancelled',
              notify: false,
              checkTradingView: true
            },
            `The bot will place a buy order in the next tick because could not retrieve the cancelled order result.`
          );
        } else {
          // Reset buy open orders
          data.buy.openOrders = [];

          // Set action as buy
          data.action = 'buy';

          data.accountInfo = await getAccountInfoFromAPI(logger);
        }
      } else {
        logger.info(
          { stopPrice: order.stopPrice, buyLimitPrice },
          'Stop price is less than buy limit price, wait for buy order'
        );
        // Set action as buy
        data.action = 'buy-order-wait';
      }
    }

    if (order.side.toLowerCase() === 'sell') {
      // Is the stop price is less than current limit price?
      if (parseFloat(order.stopPrice) <= sellLimitPrice) {
        logger.info(
          { stopPrice: order.stopPrice, sellLimitPrice, saveLog: true },
          'Stop price is less than sell limit price, cancel current sell order'
        );

        // Cancel current order
        const cancelResult = await cancelOrder(logger, symbol, order);
        if (cancelResult === false) {
          // If cancelling the order is failed, it means the order may already be executed or does not exist anymore.
          // Hence, refresh the order and process again in the next tick.
          // Get open orders and update cache

          const {
            accountInfo,
            openOrders: updatedOpenOrders,
            sellOpenOrders
          } = await refreshOpenOrdersAndAccountInfo(logger, symbol);

          data.accountInfo = accountInfo;
          data.openOrders = updatedOpenOrders;
          data.sell.openOrders = sellOpenOrders;

          data.action = 'sell-order-checking';
        } else {
          // Reset sell open orders
          data.sell.openOrders = [];

          // Set action as sell
          data.action = 'sell';

          // Refresh account info
          data.accountInfo = await getAccountInfoFromAPI(logger);
        }
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
