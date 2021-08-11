const moment = require('moment');
const _ = require('lodash');

const { cache, slack, PubSub, binance } = require('../../../helpers');
const {
  calculateLastBuyPrice,
  getAPILimit,
  isExceedAPILimit,
  disableAction,
  saveOrder
} = require('../../trailingTradeHelper/common');

const {
  saveSymbolGridTrade
} = require('../../trailingTradeHelper/configuration');

/**
 * Retrieve last grid order from cache
 *
 * @param {*} logger
 * @param {*} symbol
 * @param {*} side
 * @returns
 */
const getGridTradeLastOrder = async (logger, symbol, side) => {
  const cachedLastOrder =
    JSON.parse(await cache.get(`${symbol}-grid-trade-last-${side}-order`)) ||
    {};

  logger.info(
    { cachedLastOrder },
    `Retrieved grid trade last ${side} order from cache`
  );

  return cachedLastOrder;
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
  await cache.set(
    `${symbol}-grid-trade-last-${side}-order`,
    JSON.stringify(newOrder)
  );
  logger.info(
    { debug: true },
    `Updated grid trade last ${side} order to cache`
  );
};

/**
 * Remove last order from cache
 *
 * @param {*} logger
 * @param {*} symbol
 */
const removeGridTradeLastOrder = async (logger, symbol, side) => {
  await cache.del(`${symbol}-grid-trade-last-${side}-order`);
  logger.info(
    { debug: true },
    `Deleted grid trade last ${side} order from cache`
  );
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
  logger.info({ symbol, newGridTrade }, 'Saving grid trade');

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
    action,
    featureToggle: { notifyOrderExecute, notifyDebug },
    symbolConfiguration: {
      system: {
        checkOrderExecutePeriod,
        temporaryDisableActionAfterConfirmingOrder
      }
    }
  } = data;

  if (action !== 'not-determined') {
    logger.info(
      { action },
      'Action is already defined, do not try to ensure grid order executed.'
    );
    return data;
  }

  if (isExceedAPILimit(logger)) {
    logger.info(
      { action },
      'The API limit is exceed, do not try to ensure grid order executed.'
    );
    return data;
  }

  const removeStatuses = ['CANCELED', 'REJECTED', 'EXPIRED', 'PENDING_CANCEL'];

  // Ensure buy order executed
  const lastBuyOrder = await getGridTradeLastOrder(logger, symbol, 'buy');
  if (_.isEmpty(lastBuyOrder) === false) {
    logger.info(
      { debug: true, lastBuyOrder },
      'Last grid trade buy order found'
    );

    // If filled already, then calculate average price and save
    if (lastBuyOrder.status === 'FILLED') {
      logger.info(
        { lastBuyOrder },
        'Order has already filled, calculate last buy price.'
      );

      // Calculate last buy price
      await calculateLastBuyPrice(logger, symbol, lastBuyOrder);

      // Save grid trade to the database
      const saveGridTradeResult = await saveGridTrade(
        logger,
        data,
        lastBuyOrder
      );

      if (notifyDebug) {
        slack.sendMessage(
          `${symbol} BUY Grid Trade Updated Result (${moment().format(
            'HH:mm:ss.SSS'
          )}): \n` +
            `- Save Grid Trade Result: \`\`\`${JSON.stringify(
              _.get(saveGridTradeResult, 'result', 'Not defined'),
              undefined,
              2
            )}\`\`\`\n` +
            `- Current API Usage: ${getAPILimit(logger)}`
        );
      }

      // Remove grid trade last order
      await removeGridTradeLastOrder(logger, symbol, 'buy');

      // Save order
      await saveOrder(logger, {
        order: { ...lastBuyOrder },
        botStatus: {
          savedAt: moment().format(),
          savedBy: 'ensure-grid-trade-order-executed',
          savedMessage:
            'The order has already filled and updated the last buy price.'
        }
      });

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
              nextCheck: updatedNextCheck
            },
            'The order could not be found or error occurred querying the order.'
          );

          // Set last order to be checked later
          await updateGridTradeLastOrder(logger, symbol, 'buy', {
            ...lastBuyOrder,
            nextCheck: updatedNextCheck
          });

          // Save order
          await saveOrder(logger, {
            order: { ...lastBuyOrder },
            botStatus: {
              savedAt: moment().format(),
              savedBy: 'ensure-grid-trade-order-executed',
              savedMessage:
                'The order could not be found or error occurred querying the order.'
            }
          });

          return data;
        }

        // If filled, then calculate average cost and quantity and save new last buy pirce.
        if (orderResult.status === 'FILLED') {
          logger.info(
            { lastBuyOrder },
            'The order is filled, caluclate last buy price.'
          );

          // Calculate last buy price
          await calculateLastBuyPrice(logger, symbol, orderResult);

          // Save grid trade to the database
          const saveGridTradeResult = await saveGridTrade(logger, data, {
            ...lastBuyOrder,
            ...orderResult
          });

          if (notifyDebug) {
            slack.sendMessage(
              `${symbol} BUY Grid Trade Updated Result (${moment().format(
                'HH:mm:ss.SSS'
              )}): \n` +
                `- Save Grid Trade Result: \`\`\`${JSON.stringify(
                  _.get(saveGridTradeResult, 'result', 'Not defined'),
                  undefined,
                  2
                )}\`\`\`\n` +
                `- Current API Usage: ${getAPILimit(logger)}`
            );
          }

          // Remove grid trade last order
          await removeGridTradeLastOrder(logger, symbol, 'buy');

          // Save order
          await saveOrder(logger, {
            order: {
              ...lastBuyOrder,
              ...orderResult
            },
            botStatus: {
              savedAt: moment().format(),
              savedBy: 'ensure-grid-trade-order-executed',
              savedMessage:
                'The order has filled and updated the last buy price.'
            }
          });

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
          // If order is no longer available, then delete from cache
          await removeGridTradeLastOrder(logger, symbol, 'buy');

          // Save order
          await saveOrder(logger, {
            order: {
              ...lastBuyOrder,
              ...orderResult
            },
            botStatus: {
              savedAt: moment().format(),
              savedBy: 'ensure-grid-trade-order-executed',
              savedMessage:
                'The order is no longer valid. Removed from the cache.'
            }
          });

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
              nextCheck: updatedNextCheck
            },
            'The order is not filled, update next check time.'
          );

          await updateGridTradeLastOrder(logger, symbol, 'buy', {
            ...orderResult,
            currentGridTradeIndex: lastBuyOrder.currentGridTradeIndex,
            nextCheck: updatedNextCheck
          });

          // Save order
          await saveOrder(logger, {
            order: {
              ...orderResult
            },
            botStatus: {
              savedAt: moment().format(),
              savedBy: 'ensure-grid-trade-order-executed',
              savedMessage: 'The order is not filled. Check next internal.'
            }
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
    logger.info(
      { debug: true, lastSellOrder },
      'Last grid trade sell order found'
    );

    // If filled already, then calculate average price and save
    if (lastSellOrder.status === 'FILLED') {
      logger.info({ lastSellOrder }, 'Order has already filled.');

      // Save grid trade to the database
      const saveGridTradeResult = await saveGridTrade(
        logger,
        data,
        lastSellOrder
      );
      if (notifyDebug) {
        slack.sendMessage(
          `${symbol} SELL Grid Trade Updated Result (${moment().format(
            'HH:mm:ss.SSS'
          )}): \n` +
            `- Save Grid Trade Result: \`\`\`${JSON.stringify(
              _.get(saveGridTradeResult, 'result', 'Not defined'),
              undefined,
              2
            )}\`\`\`\n` +
            `- Current API Usage: ${getAPILimit(logger)}`
        );
      }

      // Remove grid trade last order
      await removeGridTradeLastOrder(logger, symbol, 'sell');

      // Save order
      await saveOrder(logger, {
        order: { ...lastSellOrder },
        botStatus: {
          savedAt: moment().format(),
          savedBy: 'ensure-grid-trade-order-executed',
          savedMessage:
            'The order has already filled and updated the last buy price.'
        }
      });

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
              nextCheck: updatedNextCheck
            },
            'The order could not be found or error occurred querying the order.'
          );

          // Set last order to be checked later
          await updateGridTradeLastOrder(logger, symbol, 'sell', {
            ...lastSellOrder,
            nextCheck: updatedNextCheck
          });

          // Save order
          await saveOrder(logger, {
            order: {
              ...lastSellOrder
            },
            botStatus: {
              savedAt: moment().format(),
              savedBy: 'ensure-grid-trade-order-executed',
              savedMessage:
                'The order could not be found or error occurred querying the order.'
            }
          });

          return data;
        }

        // If filled, then calculate average cost and quantity and save new last buy pirce.
        if (orderResult.status === 'FILLED') {
          logger.info({ lastSellOrder }, 'The order is filled.');

          // Save grid trade to the database
          const saveGridTradeResult = await saveGridTrade(logger, data, {
            ...lastSellOrder,
            ...orderResult
          });

          if (notifyDebug) {
            slack.sendMessage(
              `${symbol} SELL Grid Trade Updated Result (${moment().format(
                'HH:mm:ss.SSS'
              )}): \n` +
                `- Save Grid Trade Result: \`\`\`${JSON.stringify(
                  _.get(saveGridTradeResult, 'result', 'Not defined'),
                  undefined,
                  2
                )}\`\`\`\n` +
                `- Current API Usage: ${getAPILimit(logger)}`
            );
          }

          // Remove grid trade last order
          await removeGridTradeLastOrder(logger, symbol, 'sell');

          // Save order
          await saveOrder(logger, {
            order: {
              ...lastSellOrder,
              ...orderResult
            },
            botStatus: {
              savedAt: moment().format(),
              savedBy: 'ensure-grid-trade-order-executed',
              savedMessage:
                'The order has filled and updated the last buy price.'
            }
          });

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
          await removeGridTradeLastOrder(logger, symbol, 'sell');

          // Save order
          await saveOrder(logger, {
            order: {
              ...lastSellOrder,
              ...orderResult
            },
            botStatus: {
              savedAt: moment().format(),
              savedBy: 'ensure-grid-trade-order-executed',
              savedMessage:
                'The order is no longer valid. Removed from the cache.'
            }
          });

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
              nextCheck: updatedNextCheck
            },
            'The order is not filled, update next check time.'
          );

          await updateGridTradeLastOrder(logger, symbol, 'sell', {
            ...orderResult,
            currentGridTradeIndex: lastSellOrder.currentGridTradeIndex,
            nextCheck: updatedNextCheck
          });

          // Save order
          await saveOrder(logger, {
            order: {
              ...orderResult
            },
            botStatus: {
              savedAt: moment().format(),
              savedBy: 'ensure-grid-trade-order-executed',
              savedMessage: 'The order is not filled. Check next internal.'
            }
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
