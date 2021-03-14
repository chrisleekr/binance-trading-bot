const _ = require('lodash');
const moment = require('moment');
const { binance, slack } = require('../../../helpers');
const { roundDown } = require('../common');

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
      filterLotSize: { stepSize, minQty },
      filterPrice: { tickSize },
      filterMinNotional: { minNotional }
    },
    symbolConfiguration: {
      sell: { enabed: tradingEnabled, stopPercentage, limitPercentage }
    },
    action,
    baseAssetBalance: { free: baseAssetFreeBalance },
    sell: { currentPrice, openOrders }
  } = data;

  if (action !== 'sell') {
    logger.info(`Do not process a sell order because action is not 'sell'.`);
    return data;
  }

  if (openOrders.length > 0) {
    data.sell.processMessage = `There are open orders for ${symbol}. Do not place an order.`;
    data.sell.updatedAt = moment().utc();

    return data;
  }

  const lotPrecision = stepSize.indexOf(1) - 1;
  const pricePrecision = tickSize.indexOf(1) - 1;

  const stopPrice = roundDown(currentPrice * stopPercentage, pricePrecision);
  const limitPrice = roundDown(currentPrice * limitPercentage, pricePrecision);

  const freeBalance = parseFloat(_.floor(baseAssetFreeBalance, lotPrecision));
  logger.info({ freeBalance }, 'Free balance');

  const orderQuantity = parseFloat(
    _.floor(freeBalance - freeBalance * (0.1 / 100), lotPrecision)
  );

  if (orderQuantity <= parseFloat(minQty)) {
    data.sell.processMessage =
      `Order quantity is less or equal than the minimum quantity - ${minQty}. ` +
      `Do not place an order.`;
    data.sell.updatedAt = moment().utc();

    return data;
  }

  if (orderQuantity * limitPrice < parseFloat(minNotional)) {
    data.sell.processMessage = `Notional value is less than the minimum notional value. Do not place an order.`;
    data.sell.updatedAt = moment().utc();

    return data;
  }

  if (tradingEnabled === false) {
    data.sell.processMessage = `Trading for ${symbol} is disabled. Do not place an order.`;
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

  logger.info({ orderParams }, 'Sell order params');

  slack.sendMessage(`Sell Action: *STOP_LOSS_LIMIT*
  - Order Params: \`\`\`${JSON.stringify(orderParams, undefined, 2)}\`\`\`
  `);
  const orderResult = await binance.client.order(orderParams);

  logger.info({ orderResult }, 'Order result');

  await slack.sendMessage(
    `Sell Action Result: *STOP_LOSS_LIMIT*
    - Order Result: \`\`\`${JSON.stringify(orderResult, undefined, 2)}\`\`\``
  );
  data.sell.processMessage = `Placed new stop loss limit order for selling.`;
  data.sell.updatedAt = moment().utc();

  return data;
};

module.exports = { execute };
