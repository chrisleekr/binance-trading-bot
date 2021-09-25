/* eslint-disable no-await-in-loop */
const moment = require('moment');
const _ = require('lodash');
const { PubSub, binance, slack } = require('../../../helpers');
const {
  calculateLastBuyPrice,
  getAPILimit,
  isExceedAPILimit
} = require('../../trailingTradeHelper/common');

const {
  getSymbolGridTrade,
  saveSymbolGridTrade
} = require('../../trailingTradeHelper/configuration');

const {
  getManualOrders,
  deleteManualOrder,
  saveManualOrder
} = require('../../trailingTradeHelper/order');

/**
 * Send slack message for order filled
 *
 * @param {*} logger
 * @param {*} symbol
 * @param {*} side
 * @param {*} orderParams
 * @param {*} orderResult
 */
const slackMessageOrderFilled = async (
  logger,
  symbol,
  side,
  orderParams,
  orderResult
) => {
  const type = orderParams.type.toUpperCase();

  PubSub.publish('frontend-notification', {
    type: 'success',
    title: `The ${side} order for ${symbol} has been executed successfully.`
  });

  return slack.sendMessage(
    `${symbol} Manual ${side.toUpperCase()} Order Filled (${moment().format(
      'HH:mm:ss.SSS'
    )}): *${type}*\n` +
      `- Order Result: \`\`\`${JSON.stringify(
        orderResult,
        undefined,
        2
      )}\`\`\`\n` +
      `- Current API Usage: ${getAPILimit(logger)}`
  );
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
    featureToggle: { notifyDebug }
  } = rawData;
  // Assummed grid trade in the symbol configuration is already up to date.
  const { side, type } = order;

  // Get current grid trade from database
  const symbolGridTrade = await getSymbolGridTrade(logger, symbol);

  // Append this order to manualTrade
  const manualTrade = _.get(symbolGridTrade, 'manual', []);
  manualTrade.push(order);
  symbolGridTrade.manualTrade = manualTrade;

  if (notifyDebug) {
    slack.sendMessage(
      `${symbol} ${side.toUpperCase()} Grid Trade Updated (${moment().format(
        'HH:mm:ss.SSS'
      )}): *${type}*\n` +
        `- New Gird Trade: \`\`\`${JSON.stringify(
          symbolGridTrade,
          undefined,
          2
        )}\`\`\`\n` +
        `- Current API Usage: ${getAPILimit(logger)}`
    );
  }
  return saveSymbolGridTrade(logger, symbol, symbolGridTrade);
};

/**
 * Send slack message for order deleted
 *
 * @param {*} logger
 * @param {*} symbol
 * @param {*} side
 * @param {*} orderParams
 * @param {*} orderResult
 */
const slackMessageOrderDeleted = async (
  logger,
  symbol,
  side,
  orderParams,
  orderResult
) => {
  const type = orderParams.type.toUpperCase();

  PubSub.publish('frontend-notification', {
    type: 'success',
    title: `The ${side} order for ${symbol} is ${orderResult.status}. Stop monitoring.`
  });

  return slack.sendMessage(
    `${symbol} Manual ${side.toUpperCase()} Order Removed (${moment().format(
      'HH:mm:ss.SSS'
    )}): *${type}*\n` +
      `- Order Result: \`\`\`${JSON.stringify(
        orderResult,
        undefined,
        2
      )}\`\`\`\n` +
      `- Current API Usage: ${getAPILimit(logger)}`
  );
};

/**
 * Ensure manual buy order is placed
 *
 * @param {*} logger
 * @param {*} rawData
 */
const execute = async (logger, rawData) => {
  const data = rawData;

  const {
    symbol,
    featureToggle: { notifyDebug },
    symbolConfiguration: {
      system: { checkManualOrderPeriod }
    }
  } = data;

  if (isExceedAPILimit(logger)) {
    logger.info('The API limit is exceed, do not try to ensure manual order.');
    return data;
  }

  const manualOrders = await getManualOrders(logger, symbol);

  if (_.isEmpty(manualOrders) === true) {
    logger.info(
      { manualOrders },
      'Could not find manual buy order, do not process ensure-manual-order.'
    );
    return data;
  }

  const removeStatuses = ['CANCELED', 'REJECTED', 'EXPIRED', 'PENDING_CANCEL'];

  // Check if manual-order is existing
  // eslint-disable-next-line no-restricted-syntax
  for (const rawOrder of manualOrders) {
    const { order } = rawOrder;
    logger.info({ order }, 'Start checking buy order');
    // If filled already, then calculate average price and save
    if (order.status === 'FILLED') {
      logger.info(
        { order },
        'Order has already filled, calculate last buy price.'
      );

      // Calculate last buy price
      await calculateLastBuyPrice(logger, symbol, order);

      // Save grid trade to the database
      const saveGridTradeResult = await saveGridTrade(logger, data, order);

      if (notifyDebug) {
        slack.sendMessage(
          `${symbol} ${order.side} Grid Trade Updated Result (${moment().format(
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

      await deleteManualOrder(logger, symbol, order.orderId);
    } else {
      // If not filled, check orders is time to check or not

      const nextCheck = _.get(order, 'nextCheck', null);

      if (moment(nextCheck) < moment()) {
        // Check orders whether it's filled or not
        let orderResult;
        try {
          orderResult = await binance.client.getOrder({
            symbol,
            orderId: order.orderId
          });
        } catch (e) {
          logger.error(
            { e },
            'The order could not be found or error occurred querying the order.'
          );
          const updatedNextCheck = moment().add(
            checkManualOrderPeriod,
            'seconds'
          );

          logger.info(
            {
              e,
              order,
              checkManualOrderPeriod,
              nextCheck: updatedNextCheck.format()
            },
            'The order could not be found or error occurred querying the order.'
          );

          await saveManualOrder(logger, symbol, order.orderId, {
            ...order,
            nextCheck: updatedNextCheck.format()
          });

          return data;
        }

        // If filled, then calculate average cost and quantity and save new last buy pirce.
        if (orderResult.status === 'FILLED') {
          logger.info(
            { order },
            'The order is filled, caluclate last buy price.'
          );

          // Calulate last buy price
          await calculateLastBuyPrice(logger, symbol, orderResult);

          // Save grid trade to the database
          const saveGridTradeResult = await saveGridTrade(
            logger,
            data,
            orderResult
          );

          if (notifyDebug) {
            slack.sendMessage(
              `${symbol} ${
                order.side
              } Grid Trade Updated Result (${moment().format(
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

          // Remove manual buy order
          await deleteManualOrder(logger, symbol, orderResult.orderId);

          slackMessageOrderFilled(
            logger,
            symbol,
            order.side,
            order,
            orderResult
          );
        } else if (removeStatuses.includes(orderResult.status) === true) {
          // If order is no longer available, then delete from cache

          await deleteManualOrder(logger, symbol, orderResult.orderId);

          slackMessageOrderDeleted(
            logger,
            symbol,
            order.side,
            order,
            orderResult
          );
        } else {
          // If not filled, update next check time
          const updatedNextCheck = moment().add(
            checkManualOrderPeriod,
            'seconds'
          );

          logger.info(
            {
              orderResult,
              checkManualOrderPeriod,
              nextCheck: updatedNextCheck.format()
            },
            'The order is not filled, update next check time.'
          );

          await saveManualOrder(logger, symbol, orderResult.orderId, {
            ...orderResult,
            nextCheck: updatedNextCheck.format()
          });
        }
      } else {
        logger.info(
          { order, nextCheck, currentTime: moment() },
          'Skip checking the order'
        );
      }
    }
  }

  return data;
};

module.exports = { execute };
