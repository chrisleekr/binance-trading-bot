const _ = require('lodash');
const moment = require('moment');
const { binance, cache, slack } = require('../../../helpers');
const { roundDown } = require('../../trailingTradeHelper/util');
const {
  getAndCacheOpenOrdersForSymbol,
  getAccountInfoFromAPI,
  isExceedAPILimit,
  getAPILimit
} = require('../../trailingTradeHelper/common');

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
    isLocked,
    symbolInfo: {
      filterLotSize: { stepSize, minQty, maxQty },
      filterPrice: { tickSize },
      filterMinNotional: { minNotional }
    },
    symbolConfiguration: {
      sell: { enabled: tradingEnabled, stopPercentage, limitPercentage }
    },
    action,
    baseAssetBalance: { free: baseAssetFreeBalance },
    sell: { currentPrice, openOrders }
  } = data;

  if (isLocked) {
    logger.info(
      { isLocked },
      'Symbol is locked, do not process place-sell-order'
    );
    return data;
  }

  if (action !== 'sell') {
    logger.info(`Do not process a sell order because action is not 'sell'.`);
    return data;
  }

  if (openOrders.length > 0) {
    data.sell.processMessage = `There are open orders for ${symbol}. Do not place an order.`;
    data.sell.updatedAt = moment().utc();

    return data;
  }

  const lotPrecision = parseFloat(stepSize) === 1 ? 0 : stepSize.indexOf(1) - 1;
  const pricePrecision =
    parseFloat(tickSize) === 1 ? 0 : tickSize.indexOf(1) - 1;

  const stopPrice = roundDown(currentPrice * stopPercentage, pricePrecision);
  const limitPrice = roundDown(currentPrice * limitPercentage, pricePrecision);

  const freeBalance = parseFloat(_.floor(baseAssetFreeBalance, lotPrecision));
  logger.info({ freeBalance }, 'Free balance');

  let orderQuantity = parseFloat(
    _.floor(freeBalance - freeBalance * (0.1 / 100), lotPrecision)
  );

  if (orderQuantity <= parseFloat(minQty)) {
    data.sell.processMessage =
      `Order quantity is less or equal than the minimum quantity - ${minQty}. ` +
      `Do not place an order.`;
    data.sell.updatedAt = moment().utc();

    return data;
  }
  if (orderQuantity > parseFloat(maxQty)) {
    orderQuantity = parseFloat(maxQty);
  }

  if (orderQuantity * limitPrice < parseFloat(minNotional)) {
    data.sell.processMessage = `Notional value is less than the minimum notional value. Do not place an order.`;
    data.sell.updatedAt = moment().utc();

    return data;
  }

  if (tradingEnabled !== true) {
    data.sell.processMessage = `Trading for ${symbol} is disabled. Do not place an order.`;
    data.sell.updatedAt = moment().utc();

    return data;
  }

  if (isExceedAPILimit(logger)) {
    data.sell.processMessage = `Binance API limit has been exceeded. Do not place an order.`;
    data.sell.updatedAt = moment().utc();

    return data;
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
    `${symbol} Sell Action (${moment().format(
      'HH:mm:ss.SSS'
    )}): *STOP_LOSS_LIMIT*\n` +
      `- Order Params: \`\`\`${JSON.stringify(orderParams, undefined, 2)}\`\`\`
      \n` +
      `- Current API Usage: ${getAPILimit(logger)}`
  );

  logger.info(
    { debug: true, function: 'order', orderParams },
    'Sell order params'
  );
  const orderResult = await binance.client.order(orderParams);

  logger.info({ orderResult }, 'Order result');

  await cache.set(`${symbol}-last-sell-order`, JSON.stringify(orderResult), 15);

  // Get open orders and update cache
  data.openOrders = await getAndCacheOpenOrdersForSymbol(logger, symbol);
  data.sell.openOrders = data.openOrders.filter(
    o => o.side.toLowerCase() === 'sell'
  );

  // Refresh account info
  data.accountInfo = await getAccountInfoFromAPI(logger);

  slack.sendMessage(
    `${symbol} Sell Action Result (${moment().format(
      'HH:mm:ss.SSS'
    )}): *STOP_LOSS_LIMIT*\n` +
      `- Order Result: \`\`\`${JSON.stringify(
        orderResult,
        undefined,
        2
      )}\`\`\`\n` +
      `- Current API Usage: ${getAPILimit(logger)}`
  );
  data.sell.processMessage = `Placed new stop loss limit order for selling.`;
  data.sell.updatedAt = moment().utc();

  return data;
};

module.exports = { execute };
