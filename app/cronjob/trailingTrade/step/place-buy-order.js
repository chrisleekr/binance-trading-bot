const _ = require('lodash');
const moment = require('moment');
const { binance, slack, cache } = require('../../../helpers');
const {
  getAndCacheOpenOrdersForSymbol,
  getAccountInfoFromAPI,
  isExceedAPILimit,
  getAPILimit,
  saveOrder
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
    featureToggle: { notifyDebug },
    symbolInfo: {
      baseAsset,
      quoteAsset,
      filterLotSize: { stepSize },
      filterPrice: { tickSize },
      filterMinNotional: { minNotional }
    },
    symbolConfiguration: {
      buy: { enabled: tradingEnabled, currentGridTradeIndex, currentGridTrade },
      system: { checkOrderExecutePeriod }
    },
    action,
    quoteAssetBalance: { free: quoteAssetFreeBalance },
    buy: { currentPrice, openOrders }
  } = data;

  const humanisedGridTradeIndex = currentGridTradeIndex + 1;

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
    data.buy.processMessage =
      `There are open orders for ${symbol}. ` +
      `Do not place an order for the grid trade #${humanisedGridTradeIndex}.`;
    data.buy.updatedAt = moment().utc();

    return data;
  }

  if (currentGridTrade === null) {
    data.buy.processMessage = `Current grid trade is not defined. Cannot place an order.`;
    data.buy.updatedAt = moment().utc();

    return data;
  }

  const { maxPurchaseAmount, stopPercentage, limitPercentage } =
    currentGridTrade;
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

  const lotStepSizePrecision =
    parseFloat(stepSize) === 1 ? 0 : stepSize.indexOf(1) - 1;
  const priceTickPrecision =
    parseFloat(tickSize) === 1 ? 0 : tickSize.indexOf(1) - 1;

  const orgFreeBalance = parseFloat(
    _.floor(quoteAssetFreeBalance, priceTickPrecision)
  );
  let freeBalance = orgFreeBalance;

  logger.info({ freeBalance }, 'Free balance');
  if (freeBalance > maxPurchaseAmount) {
    freeBalance = maxPurchaseAmount;
    logger.info({ freeBalance }, 'Free balance after adjust');
  }

  if (freeBalance < parseFloat(minNotional)) {
    data.buy.processMessage =
      `Do not place a buy order for the grid trade #${humanisedGridTradeIndex} ` +
      `as not enough ${quoteAsset} to buy ${baseAsset}.`;
    data.buy.updatedAt = moment().utc();

    return data;
  }

  const stopPrice = _.floor(currentPrice * stopPercentage, priceTickPrecision);
  const limitPrice = _.floor(
    currentPrice * limitPercentage,
    priceTickPrecision
  );

  logger.info({ stopPrice, limitPrice }, 'Stop price and limit price');

  const orderQuantityBeforeCommission = parseFloat(
    _.ceil(freeBalance / limitPrice, lotStepSizePrecision)
  );
  logger.info(
    { orderQuantityBeforeCommission },
    'Order quantity before commission'
  );
  let orderQuantity = parseFloat(
    _.floor(
      orderQuantityBeforeCommission -
        orderQuantityBeforeCommission * (0.1 / 100),
      lotStepSizePrecision
    )
  );

  // If free balance is exactly same as minimum notional, then it will be failed to place the order
  // because it will be always less than minimum notional after calculating commission.
  // To avoid the minimum notional issue, add commission to free balance

  if (
    orgFreeBalance > parseFloat(minNotional) &&
    maxPurchaseAmount === parseFloat(minNotional)
  ) {
    // Note: For some reason, Binance rejects the order with exact amount of minimum notional amount.
    // For example,
    //    - Calculated limit price: 289.48 (current price) * 1.026 (limit percentage) = 297
    //    - Calcuated order quantity: 0.0337
    //    - Calculated quote amount: 297 * 0.0337 = 10.0089, which is over minimum notional value 10.
    // Above the order is rejected by Binance with MIN_NOTIONAL error.
    // As a result, I had to re-calculate if max purchase amount is exactly same as minimum notional value.
    orderQuantity = parseFloat(
      _.ceil(
        (freeBalance + freeBalance * (0.1 / 100)) / limitPrice,
        lotStepSizePrecision
      )
    );
  }

  logger.info({ orderQuantity }, 'Order quantity after commission');

  if (orderQuantity * limitPrice < parseFloat(minNotional)) {
    const processMessage =
      `Do not place a buy order for the grid trade #${humanisedGridTradeIndex} ` +
      `as not enough ${quoteAsset} ` +
      `to buy ${baseAsset} after calculating commission - Order amount: ${_.floor(
        orderQuantity * limitPrice,
        priceTickPrecision
      )} ${quoteAsset}, Minimum notional: ${minNotional}.`;
    logger.info(
      { calculatedAmount: orderQuantity * limitPrice, minNotional },
      processMessage
    );
    data.buy.processMessage = processMessage;
    data.buy.updatedAt = moment().utc();

    return data;
  }

  if (tradingEnabled !== true) {
    data.buy.processMessage =
      `Trading for ${symbol} is disabled. ` +
      `Do not place an order for the grid trade #${humanisedGridTradeIndex}.`;
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

  const notifyMessage = { orderParams };
  if (notifyDebug) {
    notifyMessage.calculationParams = {
      quoteAssetFreeBalance,
      priceTickPrecision,
      lotStepSizePrecision,
      minNotional,
      maxPurchaseAmount,
      freeBalance,
      orderQuantityBeforeCommission,
      orderQuantity,
      currentPrice,
      stopPercentage,
      limitPrice
    };
  }

  slack.sendMessage(
    `${symbol} Buy Action Grid Trade #${humanisedGridTradeIndex} (${moment().format(
      'HH:mm:ss.SSS'
    )}): *STOP_LOSS_LIMIT*\n` +
      `- Order Params: \`\`\`${JSON.stringify(
        notifyMessage,
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

  // Set last buy grid order to be checked until it is executed
  await cache.set(
    `${symbol}-grid-trade-last-buy-order`,
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
      savedBy: 'place-buy-order',
      savedMessage: 'The buy order is placed.'
    }
  });

  // Get open orders and update cache
  data.openOrders = await getAndCacheOpenOrdersForSymbol(logger, symbol);
  data.buy.openOrders = data.openOrders.filter(
    o => o.side.toLowerCase() === 'buy'
  );

  // Refresh account info
  data.accountInfo = await getAccountInfoFromAPI(logger);

  slack.sendMessage(
    `${symbol} Buy Action Grid Trade #${humanisedGridTradeIndex} Result (${moment().format(
      'HH:mm:ss.SSS'
    )}): *STOP_LOSS_LIMIT*\n` +
      `- Order Result: \`\`\`${JSON.stringify(
        orderResult,
        undefined,
        2
      )}\`\`\`\n` +
      `- Current API Usage: ${getAPILimit(logger)}`
  );
  data.buy.processMessage = `Placed new stop loss limit order for buying of grid trade #${humanisedGridTradeIndex}.`;
  data.buy.updatedAt = moment().utc();

  // Save last buy price
  return data;
};

module.exports = { execute };
