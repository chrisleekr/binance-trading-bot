const _ = require('lodash');
const moment = require('moment');
const { binance, slack } = require('../../../helpers');
const { roundDown } = require('../../trailingTradeHelper/util');
const {
  isExceedAPILimit,
  getAPILimit,
  getAndCacheOpenOrdersForSymbol,
  getAccountInfoFromAPI
} = require('../../trailingTradeHelper/common');
const { saveGridTradeOrder } = require('../../trailingTradeHelper/order');

/**
 * Set message and return data
 *
 * @param {*} logger
 * @param {*} rawData
 * @param {*} processMessage
 * @returns
 */
const setMessage = (logger, rawData, processMessage) => {
  const data = rawData;

  logger.info({ data, saveLog: true }, processMessage);
  data.sell.processMessage = processMessage;
  data.sell.updatedAt = moment().utc().toDate();
  return data;
};

/**
 * Place a sell order if has enough balance
 *
 * @param {*} logger
 * @param {*} rawData
 */
const execute = async (logger, rawData) => {
  const data = rawData;

  const {
    symbol,
    symbolInfo: {
      filterLotSize: { stepSize, minQty, maxQty },
      filterPrice: { tickSize },
      filterMinNotional: { minNotional }
    },
    symbolConfiguration: {
      sell: { enabled: tradingEnabled, currentGridTradeIndex, currentGridTrade }
    },
    action,
    baseAssetBalance: { free: baseAssetFreeBalance },
    sell: { currentPrice, openOrders }
  } = data;

  const humanisedGridTradeIndex = currentGridTradeIndex + 1;

  if (action !== 'sell') {
    logger.info(`Do not process a sell order because action is not 'sell'.`);
    return data;
  }

  if (openOrders.length > 0) {
    return setMessage(
      logger,
      data,
      `There are open orders for ${symbol}. ` +
        `Do not place an order for the grid trade #${humanisedGridTradeIndex}.`
    );
  }

  if (currentGridTrade === null) {
    return setMessage(
      logger,
      data,
      `Current grid trade is not defined. Do not place an order.`
    );
  }

  const { stopPercentage, limitPercentage, quantityPercentage } =
    currentGridTrade;

  const lotPrecision = parseFloat(stepSize) === 1 ? 0 : stepSize.indexOf(1) - 1;
  const pricePrecision =
    parseFloat(tickSize) === 1 ? 0 : tickSize.indexOf(1) - 1;

  const stopPrice = roundDown(currentPrice * stopPercentage, pricePrecision);
  const limitPrice = roundDown(currentPrice * limitPercentage, pricePrecision);

  const freeBalance = parseFloat(_.floor(baseAssetFreeBalance, lotPrecision));
  logger.info({ freeBalance }, 'Free balance');

  // If after calculating quantity percentage, it is not enough minimum notional, then simply sell all balance
  let orderQuantity = parseFloat(
    _.floor(freeBalance - freeBalance * (0.1 / 100), lotPrecision)
  );

  // When order quantity multiply quantity percentage is more than minimum notional
  const orderQuantityWithPercentage = parseFloat(
    _.floor(
      freeBalance * quantityPercentage -
        freeBalance * quantityPercentage * (0.1 / 100),
      lotPrecision
    )
  );

  logger.info(
    { orderQuantityWithPercentage: orderQuantity },
    'Calculated order quantity with quantity percentage.'
  );

  if (orderQuantityWithPercentage * limitPrice > parseFloat(minNotional)) {
    // Then calculate order quantity
    orderQuantity = orderQuantityWithPercentage;
    logger.info(
      { orderQuantityWithPercentage: orderQuantity },
      'Apply order quantity with quantity percentage.'
    );
  }

  if (orderQuantity <= parseFloat(minQty)) {
    return setMessage(
      logger,
      data,
      `Order quantity is less or equal than the minimum quantity - ${minQty}. ` +
        `Do not place an order for the grid trade #${humanisedGridTradeIndex}.`
    );
  }
  if (orderQuantity > parseFloat(maxQty)) {
    orderQuantity = parseFloat(maxQty);
  }

  if (orderQuantity * limitPrice < parseFloat(minNotional)) {
    return setMessage(
      logger,
      data,
      `Notional value is less than the minimum notional value. ` +
        `Do not place an order for the grid trade #${humanisedGridTradeIndex}.`
    );
  }

  if (tradingEnabled !== true) {
    return setMessage(
      logger,
      data,
      `Trading for ${symbol} is disabled. ` +
        `Do not place an order for the grid trade #${humanisedGridTradeIndex}.`
    );
  }

  if (isExceedAPILimit(logger)) {
    return setMessage(
      logger,
      data,
      `Binance API limit has been exceeded. ` +
        `Do not place an order for the grid trade #${humanisedGridTradeIndex}.`
    );
  }

  const orderParams = {
    symbol,
    side: 'sell',
    type: 'STOP_LOSS_LIMIT',
    quantity: orderQuantity,
    stopPrice,
    price: limitPrice,
    timeInForce: 'GTC'
  };

  slack.sendMessage(
    `*${symbol}* Sell Action Grid Trade #${humanisedGridTradeIndex}: *STOP_LOSS_LIMIT*\n` +
      `- Order Params: \`\`\`${JSON.stringify(
        orderParams,
        undefined,
        2
      )}\`\`\``,
    { symbol, apiLimit: getAPILimit(logger) }
  );

  logger.info(
    { function: 'order', orderParams, saveLog: true },
    `The grid trade #${humanisedGridTradeIndex} sell order will be placed.`
  );
  const orderResult = await binance.client.order(orderParams);

  logger.info(
    { orderResult, saveLog: true },
    `The grid trade #${humanisedGridTradeIndex} sell order has been placed.`
  );

  // Set last sell grid order to be checked until it is executed

  await saveGridTradeOrder(logger, `${symbol}-grid-trade-last-sell-order`, {
    ...orderResult,
    currentGridTradeIndex
  });

  // FIXME: If you change this comment, please refactor to use common.js:refreshOpenOrdersAndAccountInfo
  // Get open orders and update cache
  data.openOrders = await getAndCacheOpenOrdersForSymbol(logger, symbol);
  data.sell.openOrders = data.openOrders.filter(
    o => o.side.toLowerCase() === 'sell'
  );

  // Refresh account info
  data.accountInfo = await getAccountInfoFromAPI(logger);

  slack.sendMessage(
    `*${symbol}* Sell Action Grid Trade #${humanisedGridTradeIndex} Result: *STOP_LOSS_LIMIT*\n` +
      `- Order Result: \`\`\`${JSON.stringify(
        orderResult,
        undefined,
        2
      )}\`\`\``,
    { symbol, apiLimit: getAPILimit(logger) }
  );

  return setMessage(
    logger,
    data,
    `Placed new stop loss limit order for selling of grid trade #${humanisedGridTradeIndex}.`
  );
};

module.exports = { execute };
