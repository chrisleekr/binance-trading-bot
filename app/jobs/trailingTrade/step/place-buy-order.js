const _ = require('lodash');
const moment = require('moment');
const { binance, slack, mongo } = require('../../../helpers');
const { roundDown } = require('../common');

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

  if (action !== 'buy') {
    logger.info(`Do not process a buy order because action is not 'buy'.`);
    return data;
  }

  if (openOrders.length > 0) {
    data.buy.processMessage = `There are open orders for ${symbol}. Do not place an order.`;
    data.buy.updatedAt = moment().utc();

    return data;
  }

  const lotPrecision = stepSize.indexOf(1) - 1;
  const pricePrecision = tickSize.indexOf(1) - 1;

  let freeBalance = parseFloat(_.floor(quoteAssetFreeBalance, lotPrecision));
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

  const orderParams = {
    symbol,
    side: 'buy',
    type: 'STOP_LOSS_LIMIT',
    quantity: orderQuantity,
    stopPrice,
    price: limitPrice,
    timeInForce: 'GTC'
  };

  logger.info({ orderParams }, 'Buy order params');

  slack.sendMessage(`Buy Action: *STOP_LOSS_LIMIT*
  - Order Params: \`\`\`${JSON.stringify(orderParams, undefined, 2)}\`\`\`
  `);
  const orderResult = await binance.client.order(orderParams);

  logger.info({ orderResult }, 'Order result');

  await mongo.upsertOne(
    logger,
    'trailing-trade-symbols',
    {
      key: `${symbol}-last-buy-price`
    },
    {
      key: `${symbol}-last-buy-price`,
      lastBuyPrice: limitPrice
    }
  );

  await slack.sendMessage(
    `Buy Action Result: *STOP_LOSS_LIMIT*
    - Order Result: \`\`\`${JSON.stringify(orderResult, undefined, 2)}\`\`\``
  );
  data.buy.processMessage = `Placed new stop loss limit order for buying.`;
  data.buy.updatedAt = moment().utc();

  // Save last buy price
  return data;
};

module.exports = { execute };
