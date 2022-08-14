/* eslint-disable no-await-in-loop */
const moment = require('moment');
const _ = require('lodash');
const { PubSub, slack } = require('../../../helpers');
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
  deleteManualOrder
} = require('../../trailingTradeHelper/order');

/**
 * Send slack message for order filled
 *
 * @param {*} logger
 * @param {*} symbol
 * @param {*} side
 * @param {*} order
 */
const slackMessageOrderFilled = async (logger, symbol, side, order) => {
  const type = order.type.toUpperCase();

  PubSub.publish('frontend-notification', {
    type: 'success',
    title: `The ${side} order for ${symbol} has been executed successfully.`
  });

  slack.sendMessage(
    `*${symbol}* Manual ${side.toUpperCase()} Order Filled: *${type}*\n` +
      `- Order Result: \`\`\`${JSON.stringify(order, undefined, 2)}\`\`\``,
    { symbol, apiLimit: getAPILimit(logger) }
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
  const manualTrade = _.get(symbolGridTrade, 'manualTrade', []);
  manualTrade.push(order);
  symbolGridTrade.manualTrade = manualTrade;

  if (notifyDebug) {
    slack.sendMessage(
      `*${symbol}* ${side.toUpperCase()} Grid Trade Updated: *${type}*\n` +
        `- New Gird Trade: \`\`\`${JSON.stringify(
          symbolGridTrade,
          undefined,
          2
        )}\`\`\``,
      { symbol, apiLimit: getAPILimit(logger) }
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
 * @param {*} order
 */
const slackMessageOrderDeleted = async (logger, symbol, side, order) => {
  const type = order.type.toUpperCase();

  PubSub.publish('frontend-notification', {
    type: 'success',
    title: `The ${side} order for ${symbol} is ${order.status}. Stop monitoring.`
  });

  slack.sendMessage(
    `*${symbol}* Manual ${side.toUpperCase()} Order Removed: *${type}*\n` +
      `- Order Result: \`\`\`${JSON.stringify(order, undefined, 2)}\`\`\``,
    { symbol, apiLimit: getAPILimit(logger) }
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

  const { symbol } = data;

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
        { order, saveLog: true },
        'The manual order has already filled. Calculating last buy price...'
      );

      // Calculate last buy price if buy
      if (order.side === 'BUY') {
        await calculateLastBuyPrice(logger, symbol, order);
      }

      // Save grid trade to the database
      await saveGridTrade(logger, data, order);

      await deleteManualOrder(logger, symbol, order.orderId);

      slackMessageOrderFilled(logger, symbol, order.side, order);
    } else if (removeStatuses.includes(order.status)) {
      // If order is no longer available, then delete from cache
      await deleteManualOrder(logger, symbol, order.orderId);

      slackMessageOrderDeleted(logger, symbol, order.side, order);
    } else {
      logger.info(
        { order, currentTime: moment().format() },
        'Skip checking the order'
      );
    }
  }

  return data;
};

module.exports = { execute };
