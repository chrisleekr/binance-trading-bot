const moment = require('moment');
const _ = require('lodash');

const { slack, PubSub, binance } = require('../../../helpers');
const {
  calculateLastBuyPrice,
  getAPILimit,
  isExceedAPILimit,
  disableAction,
  saveOrderStats
} = require('../../trailingTradeHelper/common');

const {
  saveSymbolGridTrade
} = require('../../trailingTradeHelper/configuration');
const {
  getGridTradeOrder,
  deleteGridTradeOrder,
  saveGridTradeOrder
} = require('../../trailingTradeHelper/order');

/**
 * Retrieve last grid order from cache
 *
 * @param {*} logger
 * @param {*} symbol
 * @param {*} side
 * @returns
 */
const getGridTradeLastOrder = async (logger, symbol, side) => {
  const lastOrder =
    (await getGridTradeOrder(
      logger,
      `${symbol}-grid-trade-last-${side}-order`
    )) || {};

  logger.info(
    { lastOrder },
    `Retrieved grid trade last ${side} order from cache`
  );

  return lastOrder;
};

/**
 * Update grid trade order
 *
 * @param {*} logger
 * @param {*} symbol
 * @param {*} side
 * @param {*} newOrder
 */
const updateGridTradeLastOrder = async (logger, symbol, side, newOrder) => {
  await saveGridTradeOrder(
    logger,
    `${symbol}-grid-trade-last-${side}-order`,
    newOrder
  );

  logger.info(`Updated grid trade last ${side} order to cache`);
};

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
 * @param {*} orderParams
 * @param {*} orderResult
 * @param {*} notifyOrderExecute
 */
const slackMessageOrderFilled = async (
  logger,
  symbol,
  side,
  orderParams,
  orderResult,
  notifyOrderExecute
) => {
  const type =
    orderParams?.type?.toUpperCase() ||
    orderResult?.type?.toUpperCase() ||
    'Undefined';

  const humanisedGridTradeIndex = orderParams.currentGridTradeIndex + 1;

  logger.info(
    {
      side,
      orderParams,
      orderResult,
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
    return slack.sendMessage(
      `${symbol} ${side.toUpperCase()} Grid Trade #${humanisedGridTradeIndex} Order Filled (${moment().format(
        'HH:mm:ss.SSS'
      )}): *${type}*\n` +
        `- Order Result: \`\`\`${JSON.stringify(
          orderResult,
          undefined,
          2
        )}\`\`\`\n` +
        `- Current API Usage: ${getAPILimit(logger)}`
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
 * @param {*} orderParams
 * @param {*} orderResult
 * @param {*} notifyOrderExecute
 */
const slackMessageOrderDeleted = async (
  logger,
  symbol,
  side,
  orderParams,
  orderResult,
  notifyOrderExecute
) => {
  const type =
    orderParams?.type?.toUpperCase() ||
    orderResult?.type?.toUpperCase() ||
    'Undefined';

  const humanisedGridTradeIndex = orderParams.currentGridTradeIndex + 1;

  logger.info(
    {
      side,
      orderParams,
      orderResult,
      saveLog: true
    },
    `The ${side} order of the grid trade #${humanisedGridTradeIndex} ` +
      `for ${symbol} is ${orderResult.status}. Stop monitoring.`
  );

  PubSub.publish('frontend-notification', {
    type: 'success',
    title:
      `The ${side} order of the grid trade #${humanisedGridTradeIndex} ` +
      `for ${symbol} is ${orderResult.status}. Stop monitoring.`
  });

  if (notifyOrderExecute) {
    return slack.sendMessage(
      `${symbol} ${side.toUpperCase()} Grid Trade #${humanisedGridTradeIndex} Order Removed (${moment().format(
        'HH:mm:ss.SSS'
      )}): *${type}*\n` +
        `- Order Result: \`\`\`${JSON.stringify(
          orderResult,
          undefined,
          2
        )}\`\`\`\n` +
        `- Current API Usage: ${getAPILimit(logger)}`
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
  // Assummed grid trade in the symbol configuration is already up to date.
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
      `${symbol} ${side.toUpperCase()} Grid Trade Updated (${moment().format(
        'HH:mm:ss.SSS'
      )}): *${type}*\n` +
        `- New Gird Trade: \`\`\`${JSON.stringify(
          newGridTrade,
          undefined,
          2
        )}\`\`\`\n` +
        `- Current API Usage: ${getAPILimit(logger)}`
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
      system: {
        checkOrderExecutePeriod,
        temporaryDisableActionAfterConfirmingOrder
      }
    }
  } = data;

  if (isExceedAPILimit(logger)) {
    logger.info(
      'The API limit is exceed, do not try to ensure grid order executed.'
    );
    return data;
  }

  const removeStatuses = ['CANCELED', 'REJECTED', 'EXPIRED', 'PENDING_CANCEL'];

  // Ensure buy order executed
  const lastBuyOrder = await getGridTradeLastOrder(logger, symbol, 'buy');
  if (_.isEmpty(lastBuyOrder) === false) {
    logger.info({ lastBuyOrder }, 'Last grid trade buy order found');

    // If filled already, then calculate average price and save
    if (lastBuyOrder.status === 'FILLED') {
      logger.info(
        { lastBuyOrder, saveLog: true },
        'The grid trade order has already filled. Calculating last buy price...'
      );

      // Calculate last buy price
      await calculateLastBuyPrice(logger, symbol, lastBuyOrder);

      // Save grid trade to the database
      await saveGridTrade(logger, data, lastBuyOrder);

      // Remove grid trade last order
      await removeGridTradeLastOrder(logger, symbols, symbol, 'buy');

      slackMessageOrderFilled(
        logger,
        symbol,
        'buy',
        lastBuyOrder,
        lastBuyOrder,
        notifyOrderExecute
      );

      // Lock symbol action configured seconds to avoid immediate action
      await disableAction(
        logger,
        symbol,
        {
          disabledBy: 'buy filled order',
          message: 'Disabled action after confirming filled grid trade order.',
          canResume: false,
          canRemoveLastBuyPrice: false
        },
        temporaryDisableActionAfterConfirmingOrder
      );
    } else {
      // If not filled, check orders is time to check or not
      const nextCheck = _.get(lastBuyOrder, 'nextCheck', null);
      if (moment(nextCheck) < moment()) {
        // Check orders whether it's filled or not
        let orderResult;
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
          const updatedNextCheck = moment().add(
            checkOrderExecutePeriod,
            'seconds'
          );

          logger.info(
            {
              e,
              lastBuyOrder,
              checkOrderExecutePeriod,
              nextCheck: updatedNextCheck.format(),
              saveLog: true
            },
            'The gird trade order could not be found or error occurred querying the order.'
          );

          // Set last order to be checked later
          await updateGridTradeLastOrder(logger, symbol, 'buy', {
            ...lastBuyOrder,
            nextCheck: updatedNextCheck.format()
          });

          return data;
        }

        // If filled, then calculate average cost and quantity and save new last buy pirce.
        if (orderResult.status === 'FILLED') {
          logger.info(
            { lastBuyOrder, saveLog: true },
            'The grid trade order is filled. Caluclating last buy price...'
          );

          // Calculate last buy price
          await calculateLastBuyPrice(logger, symbol, orderResult);

          // Save grid trade to the database
          await saveGridTrade(logger, data, {
            ...lastBuyOrder,
            ...orderResult
          });

          // Remove grid trade last order
          await removeGridTradeLastOrder(logger, symbols, symbol, 'buy');

          slackMessageOrderFilled(
            logger,
            symbol,
            'buy',
            lastBuyOrder,
            orderResult,
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
        } else if (removeStatuses.includes(orderResult.status) === true) {
          logger.info(
            {
              orderResult,
              saveLog: true
            },
            `The order status "${orderResult.status}" is no longer valid. Delete the order to stop monitoring.`
          );

          // If order is no longer available, then delete from cache
          await removeGridTradeLastOrder(logger, symbols, symbol, 'buy');

          slackMessageOrderDeleted(
            logger,
            symbol,
            'buy',
            lastBuyOrder,
            orderResult,
            notifyOrderExecute
          );
        } else {
          // If not filled, update next check time
          const updatedNextCheck = moment().add(
            checkOrderExecutePeriod,
            'seconds'
          );

          logger.info(
            {
              orderResult,
              checkOrderExecutePeriod,
              nextCheck: updatedNextCheck.format(),
              saveLog: true
            },
            'The grid trade order is not filled.'
          );

          await updateGridTradeLastOrder(logger, symbol, 'buy', {
            ...orderResult,
            currentGridTradeIndex: lastBuyOrder.currentGridTradeIndex,
            nextCheck: updatedNextCheck.format()
          });
        }
      } else {
        logger.info(
          { lastBuyOrder, nextCheck, currentTime: moment() },
          'Skip checking the grid trade last buy order'
        );
      }
    }
  }

  // Ensure buy order executed
  const lastSellOrder = await getGridTradeLastOrder(logger, symbol, 'sell');
  if (_.isEmpty(lastSellOrder) === false) {
    logger.info({ lastSellOrder }, 'Last grid trade sell order found');

    // If filled already, then calculate average price and save
    if (lastSellOrder.status === 'FILLED') {
      logger.info({ lastSellOrder }, 'Order has already filled.');

      // Save grid trade to the database
      await saveGridTrade(logger, data, lastSellOrder);

      // Remove grid trade last order
      await removeGridTradeLastOrder(logger, symbols, symbol, 'sell');

      slackMessageOrderFilled(
        logger,
        symbol,
        'sell',
        lastSellOrder,
        lastSellOrder,
        notifyOrderExecute
      );

      // Lock symbol action configured seconds to avoid immediate action
      await disableAction(
        logger,
        symbol,
        {
          disabledBy: 'sell filled order',
          message: 'Disabled action after confirming filled grid trade order.',
          canResume: false,
          canRemoveLastBuyPrice: true
        },
        temporaryDisableActionAfterConfirmingOrder
      );
    } else {
      // If not filled, check orders is time to check or not
      const nextCheck = _.get(lastSellOrder, 'nextCheck', null);

      if (moment(nextCheck) < moment()) {
        // Check orders whether it's filled or not
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
          const updatedNextCheck = moment().add(
            checkOrderExecutePeriod,
            'seconds'
          );

          logger.info(
            {
              e,
              lastSellOrder,
              checkOrderExecutePeriod,
              nextCheck: updatedNextCheck.format(),
              saveLog: true
            },
            'The grid trade order could not be found or error occurred querying the order.'
          );

          // Set last order to be checked later
          await updateGridTradeLastOrder(logger, symbol, 'sell', {
            ...lastSellOrder,
            nextCheck: updatedNextCheck.format()
          });

          return data;
        }

        // If filled, then calculate average cost and quantity and save new last buy pirce.
        if (orderResult.status === 'FILLED') {
          logger.info({ lastSellOrder }, 'The order is filled.');

          // Save grid trade to the database
          await saveGridTrade(logger, data, {
            ...lastSellOrder,
            ...orderResult
          });

          // Remove grid trade last order
          await removeGridTradeLastOrder(logger, symbols, symbol, 'sell');

          slackMessageOrderFilled(
            logger,
            symbol,
            'sell',
            lastSellOrder,
            orderResult,
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
        } else if (removeStatuses.includes(orderResult.status) === true) {
          // If order is no longer available, then delete from cache
          await removeGridTradeLastOrder(logger, symbols, symbol, 'sell');

          slackMessageOrderDeleted(
            logger,
            symbol,
            'sell',
            lastSellOrder,
            orderResult,
            notifyOrderExecute
          );
        } else {
          // If not filled, update next check time
          const updatedNextCheck = moment().add(
            checkOrderExecutePeriod,
            'seconds'
          );

          logger.info(
            {
              orderResult,
              checkOrderExecutePeriod,
              nextCheck: updatedNextCheck.format(),
              saveLog: true
            },
            'The grid trade order is not filled.'
          );

          await updateGridTradeLastOrder(logger, symbol, 'sell', {
            ...orderResult,
            currentGridTradeIndex: lastSellOrder.currentGridTradeIndex,
            nextCheck: updatedNextCheck.format()
          });
        }
      } else {
        logger.info(
          { lastSellOrder, nextCheck, currentTime: moment() },
          'Skip checking the grid trade last buy order'
        );
      }
    }
  }

  return data;
};

module.exports = { execute };
