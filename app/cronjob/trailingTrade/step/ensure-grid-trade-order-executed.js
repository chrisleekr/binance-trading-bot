const moment = require('moment');
const _ = require('lodash');

const { slack, PubSub } = require('../../../helpers');
const {
  calculateLastBuyPrice,
  getAPILimit,
  isExceedAPILimit,
  disableAction,
  saveOrderStats,
  refreshOpenOrdersAndAccountInfo
} = require('../../trailingTradeHelper/common');

const {
  saveSymbolGridTrade
} = require('../../trailingTradeHelper/configuration');
const {
  deleteGridTradeOrder,
  getGridTradeLastOrder
} = require('../../trailingTradeHelper/order');

/**
 * Remove last order from cache
 *
 * @param {*} logger
 * @param {*} symbols
 * @param {*} symbol
 * @param {*} side
 */
const removeGridTradeLastOrder = async (logger, symbols, symbol, side) => {
  await deleteGridTradeOrder(logger, `${symbol}-grid-trade-last-${side}-order`);
  logger.info(`Deleted grid trade last ${side} order from cache`);

  await saveOrderStats(logger, symbols);
};

/**
 * Send slack message for order filled
 *
 * @param {*} logger
 * @param {*} symbol
 * @param {*} side
 * @param {*} order
 * @param {*} notifyOrderExecute
 */
const slackMessageOrderFilled = async (
  logger,
  symbol,
  side,
  order,
  notifyOrderExecute
) => {
  const type = order.type.toUpperCase();

  const humanisedGridTradeIndex = order.currentGridTradeIndex + 1;

  logger.info(
    {
      side,
      order,
      saveLog: true
    },
    `The ${side} order of the grid trade #${humanisedGridTradeIndex} ` +
      `for ${symbol} has been executed successfully.`
  );

  PubSub.publish('frontend-notification', {
    type: 'success',
    title:
      `The ${side} order of the grid trade #${humanisedGridTradeIndex} ` +
      `for ${symbol} has been executed successfully.`
  });

  if (notifyOrderExecute) {
    slack.sendMessage(
      `*${symbol}* ${side.toUpperCase()} Grid Trade #${humanisedGridTradeIndex} Order Filled: *${type}*\n` +
        `- Order Result: \`\`\`${JSON.stringify(order, undefined, 2)}\`\`\``,
      { symbol, apiLimit: getAPILimit(logger) }
    );
  }

  return true;
};

/**
 * Send slack message for order deleted
 *
 * @param {*} logger
 * @param {*} symbol
 * @param {*} side
 * @param {*} order
 * @param {*} notifyOrderExecute
 */
const slackMessageOrderDeleted = async (
  logger,
  symbol,
  side,
  order,
  notifyOrderExecute
) => {
  const type = order.type.toUpperCase();

  const humanisedGridTradeIndex = order.currentGridTradeIndex + 1;

  logger.info(
    {
      side,
      order,
      saveLog: true
    },
    `The ${side} order of the grid trade #${humanisedGridTradeIndex} ` +
      `for ${symbol} is ${order.status}. Stop monitoring.`
  );

  PubSub.publish('frontend-notification', {
    type: 'success',
    title:
      `The ${side} order of the grid trade #${humanisedGridTradeIndex} ` +
      `for ${symbol} is ${order.status}. Stop monitoring.`
  });

  if (notifyOrderExecute) {
    slack.sendMessage(
      `*${symbol}* ${side.toUpperCase()} Grid Trade #${humanisedGridTradeIndex} Order Removed: *${type}*\n` +
        `- Order Result: \`\`\`${JSON.stringify(order, undefined, 2)}\`\`\``,
      { symbol, apiLimit: getAPILimit(logger) }
    );
  }
  return true;
};

/**
 * Save grid trade to database
 *
 * @param {*} logger
 * @param {*} rawData
 * @param {*} order
 */
const saveGridTrade = async (logger, rawData, order) => {
  const {
    symbol,
    featureToggle: { notifyDebug },
    symbolConfiguration: {
      buy: { gridTrade: buyGridTrade },
      sell: { gridTrade: sellGridTrade }
    }
  } = rawData;
  // Assumed grid trade in the symbol configuration is already up to date.
  const { side, type, currentGridTradeIndex } = order;

  const newGridTrade = {
    buy: buyGridTrade,
    sell: sellGridTrade
  };
  logger.info(
    { side, currentGridTradeIndex, newGridTrade },
    'Grid trade before updating'
  );

  const selectedSide = side.toLowerCase();

  const currentGridTrade = newGridTrade[selectedSide][currentGridTradeIndex];

  currentGridTrade.executed = true;
  currentGridTrade.executedOrder = order;

  newGridTrade[selectedSide][currentGridTradeIndex] = currentGridTrade;
  logger.info({ symbol, newGridTrade }, 'Grid Trade updated');

  if (notifyDebug) {
    slack.sendMessage(
      `*${symbol}* ${side.toUpperCase()} Grid Trade Updated: *${type}*\n` +
        `- New Gird Trade: \`\`\`${JSON.stringify(
          newGridTrade,
          undefined,
          2
        )}\`\`\``,
      { symbol, apiLimit: getAPILimit(logger) }
    );
  }
  return saveSymbolGridTrade(logger, symbol, newGridTrade);
};

/**
 * Ensure order is executed
 *
 * @param {*} logger
 * @param {*} rawData
 */
const execute = async (logger, rawData) => {
  const data = rawData;

  const {
    symbol,
    featureToggle: { notifyOrderExecute },
    symbolConfiguration: {
      symbols,
      system: { temporaryDisableActionAfterConfirmingOrder }
    }
  } = data;

  if (isExceedAPILimit(logger)) {
    logger.info(
      'The API limit is exceed, do not try to ensure grid order executed.'
    );
    return data;
  }

  const removeStatuses = ['CANCELED', 'REJECTED', 'EXPIRED', 'PENDING_CANCEL'];
  const fillStatuses = ['FILLED', 'PARTIALLY_FILLED'];

  // Ensure buy order executed
  const lastBuyOrder = await getGridTradeLastOrder(logger, symbol, 'buy');
  if (_.isEmpty(lastBuyOrder) === false) {
    logger.info({ lastBuyOrder }, 'Last grid trade buy order found');

    // If filled already, then calculate average price and save
    if (fillStatuses.includes(lastBuyOrder.status)) {
      logger.info(
        { lastBuyOrder, saveLog: true },
        'The grid trade order has filled. Calculating last buy price...'
      );

      // Calculate last buy price
      await calculateLastBuyPrice(logger, symbol, lastBuyOrder);

      // Save grid trade to the database
      await saveGridTrade(logger, data, lastBuyOrder);

      const {
        accountInfo,
        openOrders: updatedOpenOrders,
        buyOpenOrders
      } = await refreshOpenOrdersAndAccountInfo(logger, symbol);

      data.accountInfo = accountInfo;
      data.openOrders = updatedOpenOrders;
      data.buy.openOrders = buyOpenOrders;

      // Remove grid trade last order
      if (lastBuyOrder.status === 'FILLED') {
        await removeGridTradeLastOrder(logger, symbols, symbol, 'buy');

        slackMessageOrderFilled(
          logger,
          symbol,
          'buy',
          lastBuyOrder,
          notifyOrderExecute
        );

        // Lock symbol action configured seconds to avoid immediate action
        await disableAction(
          logger,
          symbol,
          {
            disabledBy: 'buy filled order',
            message:
              'Disabled action after confirming filled grid trade order.',
            canResume: false,
            canRemoveLastBuyPrice: false
          },
          temporaryDisableActionAfterConfirmingOrder
        );

        PubSub.publish('check-open-orders', {});
      }
    } else if (removeStatuses.includes(lastBuyOrder.status)) {
      logger.info(
        {
          lastBuyOrder,
          saveLog: true
        },
        `The order status "${lastBuyOrder.status}" is no longer valid. Delete the order to stop monitoring.`
      );
      // If order is no longer available, then delete from cache
      await removeGridTradeLastOrder(logger, symbols, symbol, 'buy');

      const {
        accountInfo,
        openOrders: updatedOpenOrders,
        buyOpenOrders
      } = await refreshOpenOrdersAndAccountInfo(logger, symbol);

      data.accountInfo = accountInfo;
      data.openOrders = updatedOpenOrders;
      data.buy.openOrders = buyOpenOrders;

      slackMessageOrderDeleted(
        logger,
        symbol,
        'buy',
        lastBuyOrder,
        notifyOrderExecute
      );
    } else {
      logger.info(
        { lastBuyOrder, currentTime: moment().format() },
        'Skip checking the grid trade last buy order'
      );
    }
  }

  // Ensure sell order executed
  const lastSellOrder = await getGridTradeLastOrder(logger, symbol, 'sell');
  if (_.isEmpty(lastSellOrder) === false) {
    logger.info({ lastSellOrder }, 'Last grid trade sell order found');

    // If filled already, then calculate average price and save
    if (fillStatuses.includes(lastSellOrder.status)) {
      logger.info({ lastSellOrder }, 'Order has already filled.');

      // Save grid trade to the database
      await saveGridTrade(logger, data, lastSellOrder);

      const {
        accountInfo,
        openOrders: updatedOpenOrders,
        sellOpenOrders
      } = await refreshOpenOrdersAndAccountInfo(logger, symbol);

      data.accountInfo = accountInfo;
      data.openOrders = updatedOpenOrders;
      data.sell.openOrders = sellOpenOrders;

      // Remove grid trade last order
      if (lastSellOrder.status === 'FILLED') {
        await removeGridTradeLastOrder(logger, symbols, symbol, 'sell');

        slackMessageOrderFilled(
          logger,
          symbol,
          'sell',
          lastSellOrder,
          notifyOrderExecute
        );

        // Lock symbol action configured seconds to avoid immediate action
        await disableAction(
          logger,
          symbol,
          {
            disabledBy: 'sell filled order',
            message:
              'Disabled action after confirming filled grid trade order.',
            canResume: false,
            canRemoveLastBuyPrice: true
          },
          temporaryDisableActionAfterConfirmingOrder
        );
      }
    } else if (removeStatuses.includes(lastSellOrder.status)) {
      // If order is no longer available, then delete from cache
      await removeGridTradeLastOrder(logger, symbols, symbol, 'sell');

      const {
        accountInfo,
        openOrders: updatedOpenOrders,
        sellOpenOrders
      } = await refreshOpenOrdersAndAccountInfo(logger, symbol);

      data.accountInfo = accountInfo;
      data.openOrders = updatedOpenOrders;
      data.sell.openOrders = sellOpenOrders;

      slackMessageOrderDeleted(
        logger,
        symbol,
        'sell',
        lastSellOrder,
        notifyOrderExecute
      );
    } else {
      logger.info(
        { lastSellOrder, currentTime: moment().format() },
        'Skip checking the grid trade last sell order'
      );
    }
  }

  return data;
};

module.exports = { execute };
