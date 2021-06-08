const _ = require('lodash');
const moment = require('moment');
const { binance, slack, mongo, cache } = require('../../../helpers');
const { roundDown } = require('../../trailingTradeHelper/util');
const {
  getAndCacheOpenOrdersForSymbol,
  getAccountInfoFromAPI,
  isExceedAPILimit,
  getAPILimit
} = require('../../trailingTradeHelper/common');

/**
 * Place a buy order if has enough balance
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
      baseAsset,
      quoteAsset,
      filterLotSize: { stepSize },
      filterPrice: { tickSize },
      filterMinNotional: { minNotional }
    },
    symbolConfiguration: {
      buy: {
        enabled: tradingEnabled,
        maxPurchaseAmount,
        stopPercentage,
        limitPercentage
      }
    },
    action,
    quoteAssetBalance: { free: quoteAssetFreeBalance },
    buy: { currentPrice, openOrders }
  } = data;

  if (isLocked) {
    logger.info(
      { isLocked },
      'Symbol is locked, do not process place-buy-order'
    );
    return data;
  }

  if (action !== 'buy') {
    logger.info(`Do not process a buy order because action is not 'buy'.`);
    return data;
  }

  if (openOrders.length > 0) {
    data.buy.processMessage = `There are open orders for ${symbol}. Do not place an order.`;
    data.buy.updatedAt = moment().utc();

    return data;
  }

  if (maxPurchaseAmount <= 0) {
    data.buy.processMessage =
      'Max purchase amount must be configured. Please configure symbol settings.';
    data.buy.updatedAt = moment().utc();

    return data;
  }

  logger.info(
    { debug: true, currentPrice, openOrders },
    'Attempting to place buy order'
  );

  const lotPrecision = parseFloat(stepSize) === 1 ? 0 : stepSize.indexOf(1) - 1;
  const pricePrecision =
    parseFloat(tickSize) === 1 ? 0 : tickSize.indexOf(1) - 1;

  let freeBalance = parseFloat(_.floor(quoteAssetFreeBalance, pricePrecision));

  logger.info({ freeBalance }, 'Free balance');
  if (freeBalance > maxPurchaseAmount) {
    freeBalance = maxPurchaseAmount;
    logger.info({ freeBalance }, 'Free balance after adjust');
  }

  if (freeBalance < parseFloat(minNotional)) {
    data.buy.processMessage = `Do not place a buy order as not enough ${quoteAsset} to buy ${baseAsset}.`;
    data.buy.updatedAt = moment().utc();

    return data;
  }

  const stopPrice = roundDown(currentPrice * stopPercentage, pricePrecision);
  const limitPrice = roundDown(currentPrice * limitPercentage, pricePrecision);

  logger.info({ stopPrice, limitPrice }, 'Stop price and limit price');

  const orderQuantityBeforeCommission = 1 / (limitPrice / freeBalance);
  logger.info(
    { orderQuantityBeforeCommission },
    'Order quantity before commission'
  );
  const orderQuantity = parseFloat(
    _.floor(
      orderQuantityBeforeCommission -
        orderQuantityBeforeCommission * (0.1 / 100),
      lotPrecision
    )
  );

  logger.info({ orderQuantity }, 'Order quantity after commission');

  if (orderQuantity * limitPrice < parseFloat(minNotional)) {
    data.buy.processMessage =
      `Do not place a buy order as not enough ${quoteAsset} ` +
      `to buy ${baseAsset} after calculation.`;
    data.buy.updatedAt = moment().utc();

    return data;
  }

  if (tradingEnabled !== true) {
    data.buy.processMessage = `Trading for ${symbol} is disabled. Do not place an order.`;
    data.buy.updatedAt = moment().utc();

    return data;
  }

  if (isExceedAPILimit(logger)) {
    data.buy.processMessage = `Binance API limit has been exceeded. Do not place an order.`;
    data.buy.updatedAt = moment().utc();

    return data;
  }

  const orderParams = {
    symbol,
    side: 'buy',
    type: 'STOP_LOSS_LIMIT',
    quantity: orderQuantity,
    stopPrice,
    price: limitPrice,
    timeInForce: 'GTC'
  };

  slack.sendMessage(
    `${symbol} Buy Action (${moment().format(
      'HH:mm:ss.SSS'
    )}): *STOP_LOSS_LIMIT*\n` +
      `- Order Params: \`\`\`${JSON.stringify(
        orderParams,
        undefined,
        2
      )}\`\`\`\n` +
      `- Current API Usage: ${getAPILimit(logger)}`
  );

  logger.info(
    { debug: true, function: 'order', orderParams },
    'Buy order params'
  );
  const orderResult = await binance.client.order(orderParams);

  logger.info({ orderResult }, 'Order result');

  // Set last buy order to be checked over 2 minutes
  await cache.set(`${symbol}-last-buy-order`, JSON.stringify(orderResult), 120);

  await mongo.upsertOne(
    logger,
    'trailing-trade-symbols',
    {
      key: `${symbol}-last-buy-price`
    },
    {
      key: `${symbol}-last-buy-price`,
      lastBuyPrice: limitPrice,
      quantity: orderQuantity
    }
  );

  // Get open orders and update cache
  data.openOrders = await getAndCacheOpenOrdersForSymbol(logger, symbol);
  data.buy.openOrders = data.openOrders.filter(
    o => o.side.toLowerCase() === 'buy'
  );

  // Refresh account info
  data.accountInfo = await getAccountInfoFromAPI(logger);

  slack.sendMessage(
    `${symbol} Buy Action Result (${moment().format(
      'HH:mm:ss.SSS'
    )}): *STOP_LOSS_LIMIT*\n` +
      `- Order Result: \`\`\`${JSON.stringify(
        orderResult,
        undefined,
        2
      )}\`\`\`\n` +
      `- Current API Usage: ${getAPILimit(logger)}`
  );
  data.buy.processMessage = `Placed new stop loss limit order for buying.`;
  data.buy.updatedAt = moment().utc();

  // Save last buy price
  return data;
};

module.exports = { execute };
