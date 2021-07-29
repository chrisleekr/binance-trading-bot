const _ = require('lodash');
const moment = require('moment');
const { binance, cache, slack } = require('../../../helpers');
const { roundDown } = require('../../trailingTradeHelper/util');
const {
  getAndCacheOpenOrdersForSymbol,
  getAccountInfoFromAPI,
  isExceedAPILimit,
  getAPILimit,
  saveOrder
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
      sell: {
        enabled: tradingEnabled,
        currentGridTradeIndex,
        currentGridTrade
      },
      system: { checkOrderExecutePeriod }
    },
    action,
    baseAssetBalance: { free: baseAssetFreeBalance },
    sell: { currentPrice, openOrders }
  } = data;

  const humanisedGridTradeIndex = currentGridTradeIndex + 1;

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
    data.sell.processMessage =
      `There are open orders for ${symbol}. ` +
      `Do not place an order for the grid trade #${humanisedGridTradeIndex}.`;
    data.sell.updatedAt = moment().utc();

    return data;
  }

  if (currentGridTrade === null) {
    data.sell.processMessage = `Current grid trade is not defined. Do not place an order.`;
    data.sell.updatedAt = moment().utc();

    return data;
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
    data.sell.processMessage =
      `Order quantity is less or equal than the minimum quantity - ${minQty}. ` +
      `Do not place an order for the grid trade #${humanisedGridTradeIndex}.`;
    data.sell.updatedAt = moment().utc();

    return data;
  }
  if (orderQuantity > parseFloat(maxQty)) {
    orderQuantity = parseFloat(maxQty);
  }

  if (orderQuantity * limitPrice < parseFloat(minNotional)) {
    data.sell.processMessage =
      `Notional value is less than the minimum notional value. ` +
      `Do not place an order for the grid trade #${humanisedGridTradeIndex}.`;
    data.sell.updatedAt = moment().utc();

    return data;
  }

  if (tradingEnabled !== true) {
    data.sell.processMessage =
      `Trading for ${symbol} is disabled. ` +
      `Do not place an order for the grid trade #${humanisedGridTradeIndex}.`;
    data.sell.updatedAt = moment().utc();

    return data;
  }

  if (isExceedAPILimit(logger)) {
    data.sell.processMessage =
      `Binance API limit has been exceeded. ` +
      `Do not place an order for the grid trade #${humanisedGridTradeIndex}.`;
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
    `${symbol} Sell Action Grid Trade #${humanisedGridTradeIndex}(${moment().format(
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

  // Set last sell grid order to be checked until it is executed
  await cache.set(
    `${symbol}-grid-trade-last-sell-order`,
    JSON.stringify({
      ...orderResult,
      currentGridTradeIndex,
      nextCheck: moment().add(checkOrderExecutePeriod, 'seconds')
    })
  );

  // Save order
  await saveOrder(logger, {
    order: {
      ...orderResult
    },
    botStatus: {
      savedAt: moment().format(),
      savedBy: 'place-sell-order',
      savedMessage: 'The sell order is placed.'
    }
  });

  // Get open orders and update cache
  data.openOrders = await getAndCacheOpenOrdersForSymbol(logger, symbol);
  data.sell.openOrders = data.openOrders.filter(
    o => o.side.toLowerCase() === 'sell'
  );

  // Refresh account info
  data.accountInfo = await getAccountInfoFromAPI(logger);

  slack.sendMessage(
    `${symbol} Sell Action Grid Trade #${humanisedGridTradeIndex} Result (${moment().format(
      'HH:mm:ss.SSS'
    )}): *STOP_LOSS_LIMIT*\n` +
      `- Order Result: \`\`\`${JSON.stringify(
        orderResult,
        undefined,
        2
      )}\`\`\`\n` +
      `- Current API Usage: ${getAPILimit(logger)}`
  );
  data.sell.processMessage = `Placed new stop loss limit order for selling of grid trade #${humanisedGridTradeIndex}.`;
  data.sell.updatedAt = moment().utc();

  return data;
};

module.exports = { execute };
