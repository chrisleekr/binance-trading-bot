const _ = require('lodash');
const moment = require('moment');
const { binance, slack } = require('../../../helpers');
const {
  isExceedAPILimit,
  getAPILimit,
  saveOrderStats,
  saveOverrideAction,
  refreshOpenOrdersAndAccountInfo
} = require('../../trailingTradeHelper/common');
const { saveGridTradeOrder } = require('../../trailingTradeHelper/order');
const {
  isBuyAllowedByTradingView
} = require('../../trailingTradeHelper/tradingview');

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
  data.buy.processMessage = processMessage;
  data.buy.updatedAt = moment().utc().toDate();
  return data;
};

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
    featureToggle: { notifyDebug, notifyOrderConfirm },
    symbolInfo: {
      baseAsset,
      quoteAsset,
      filterLotSize: { stepSize },
      filterPrice: { tickSize },
      filterMinNotional: { minNotional }
    },
    symbolConfiguration: {
      symbols,
      buy: { enabled: tradingEnabled, currentGridTradeIndex, currentGridTrade }
    },
    action,
    quoteAssetBalance: { free: quoteAssetFreeBalance },
    buy: { currentPrice, triggerPrice, openOrders },
    tradingViews,
    overrideData
  } = data;
  const humanisedGridTradeIndex = currentGridTradeIndex + 1;

  if (action !== 'buy') {
    logger.info(`Do not process a buy order because action is not 'buy'.`);
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
      `Current grid trade is not defined. Cannot place an order.`
    );
  }

  const { isTradingViewAllowed, tradingViewRejectedReason } =
    isBuyAllowedByTradingView(logger, data);

  if (isTradingViewAllowed === false) {
    await saveOverrideAction(
      logger,
      symbol,
      {
        action: 'buy',
        actionAt: moment().add(1, 'minutes').toISOString(),
        triggeredBy: 'buy-order-trading-view',
        notify: false,
        checkTradingView: true
      },
      `The bot queued the action to trigger the grid trade #${humanisedGridTradeIndex} for buying.` +
        ` ${tradingViewRejectedReason}`
    );

    return setMessage(logger, data, tradingViewRejectedReason);
  }

  const {
    minPurchaseAmount,
    maxPurchaseAmount,
    stopPercentage,
    limitPercentage
  } = currentGridTrade;

  if (minPurchaseAmount <= 0) {
    return setMessage(
      logger,
      data,
      'Min purchase amount must be configured. Please configure symbol settings.'
    );
  }

  if (maxPurchaseAmount <= 0) {
    return setMessage(
      logger,
      data,
      'Max purchase amount must be configured. Please configure symbol settings.'
    );
  }

  logger.info({ currentPrice, openOrders }, 'Attempting to place buy order');

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
    return setMessage(
      logger,
      data,
      `Do not place a buy order for the grid trade #${humanisedGridTradeIndex} ` +
        `as not enough ${quoteAsset} to buy ${baseAsset}.`
    );
  }

  if (freeBalance < minPurchaseAmount) {
    return setMessage(
      logger,
      data,
      `Do not place a buy order for the grid trade #${humanisedGridTradeIndex} ` +
        `because free balance is less than minimum purchase amount.`
    );
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

  const orderAmount = orderQuantity * limitPrice;

  if (orderAmount < parseFloat(minNotional)) {
    const processMessage =
      `Do not place a buy order for the grid trade #${humanisedGridTradeIndex} ` +
      `as not enough ${quoteAsset} ` +
      `to buy ${baseAsset} after calculating commission - Order amount: ${_.floor(
        orderAmount,
        priceTickPrecision
      )} ${quoteAsset}, Minimum notional: ${minNotional}.`;
    logger.info({ calculatedAmount: orderAmount, minNotional }, processMessage);

    return setMessage(logger, data, processMessage);
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
      `Binance API limit has been exceeded. Do not place an order.`
    );
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

  const calculationParams = {
    quoteAssetFreeBalance,
    priceTickPrecision,
    lotStepSizePrecision,
    minNotional,
    minPurchaseAmount,
    maxPurchaseAmount,
    freeBalance,
    orderQuantityBeforeCommission,
    orderQuantity,
    currentPrice,
    stopPercentage,
    limitPrice,
    triggerPrice,
    tradingViews: _.map(tradingViews, tradingView => ({
      request: _.get(tradingView, 'request', {}),
      result: {
        time: _.get(tradingView, 'result.time', ''),
        summary: _.get(tradingView, 'result.summary', {})
      }
    })),
    overrideData
  };

  const notifyMessage = { orderParams };
  if (notifyDebug) {
    notifyMessage.calculationParams = calculationParams;
  }

  if (notifyDebug || notifyOrderConfirm)
    slack.sendMessage(
      `*${symbol}* Action - Buy Trade #${humanisedGridTradeIndex}: *STOP_LOSS_LIMIT*\n` +
        `- Order Params: \n` +
        `\`\`\`${JSON.stringify(notifyMessage, undefined, 2)}\`\`\``,
      { symbol, apiLimit: getAPILimit(logger) }
    );

  logger.info(
    {
      function: 'order',
      orderParams,
      calculationParams,
      saveLog: true
    },
    `The grid trade #${humanisedGridTradeIndex} buy order will be placed.`
  );
  const orderResult = await binance.client.order(orderParams);

  logger.info(
    { orderResult, saveLog: true },
    `The grid trade #${humanisedGridTradeIndex} buy order has been placed.`
  );

  // Set last buy grid order to be checked until it is executed
  await saveGridTradeOrder(logger, `${symbol}-grid-trade-last-buy-order`, {
    ...orderResult,
    currentGridTradeIndex
  });

  // Save number of open orders
  await saveOrderStats(logger, symbols);

  const {
    accountInfo,
    openOrders: updatedOpenOrders,
    buyOpenOrders
  } = await refreshOpenOrdersAndAccountInfo(logger, symbol);

  data.accountInfo = accountInfo;
  data.openOrders = updatedOpenOrders;
  data.buy.openOrders = buyOpenOrders;

  if (notifyDebug || notifyOrderConfirm)
    slack.sendMessage(
      `*${symbol}* Buy Action Grid Trade #${humanisedGridTradeIndex} Result: *STOP_LOSS_LIMIT*\n` +
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
    `Placed new stop loss limit order for buying of grid trade #${humanisedGridTradeIndex}.`
  );
};

module.exports = { execute };
