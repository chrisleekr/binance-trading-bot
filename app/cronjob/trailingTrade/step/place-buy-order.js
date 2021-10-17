const _ = require('lodash');
const moment = require('moment');
const { binance, slack } = require('../../../helpers');
const {
  getAndCacheOpenOrdersForSymbol,
  getAccountInfoFromAPI,
  isExceedAPILimit,
  getAPILimit,
  saveOrderStats,
  saveOverrideAction
} = require('../../trailingTradeHelper/common');
const { saveGridTradeOrder } = require('../../trailingTradeHelper/order');

/**
 * Check whether recommendation is allowed or not.
 *
 * @param {*} logger
 * @param {*} data
 * @returns
 */
const isAllowedTradingViewRecommendation = (logger, data) => {
  const {
    symbol,
    featureToggle: { notifyDebug },
    symbolConfiguration: {
      buy: {
        tradingView: {
          whenStrongBuy: tradingViewWhenStrongBuy,
          whenBuy: tradingViewWhenBuy
        },
        currentGridTradeIndex
      },
      botOptions: {
        tradingView: {
          useOnlyWithin: tradingViewUseOnlyWithin,
          ifExpires: tradingViewIfExpires
        }
      }
    },
    tradingView,
    overrideData
  } = data;

  const overrideCheckTradingView = _.get(
    overrideData,
    'checkTradingView',
    false
  );

  // If this is override action, then process buy regardless recommendation.
  if (overrideCheckTradingView === false && _.isEmpty(overrideData) === false) {
    logger.info(
      { overrideData },
      'Override data is not empty. Ignore TradingView recommendation.'
    );
    return { isTradingViewAllowed: true, tradingViewRejectedReason: '' };
  }

  // If there is no tradingView result time or recommendation, then ignore TradingView recommendation.
  const tradingViewTime = _.get(tradingView, 'result.time', '');

  const tradingViewSummaryRecommendation = _.get(
    tradingView,
    'result.summary.RECOMMENDATION',
    ''
  );
  if (tradingViewTime === '' || tradingViewSummaryRecommendation === '') {
    logger.info(
      { tradingViewTime, tradingViewSummaryRecommendation },
      'TradingView time or recommendation is empty. Ignore TradingView recommendation.'
    );
    return { isTradingViewAllowed: true, tradingViewRejectedReason: '' };
  }

  // If tradingViewTime is more than configured time, then ignore TradingView recommendation.
  const tradingViewUpdatedAt = moment
    .utc(tradingViewTime, 'YYYY-MM-DDTHH:mm:ss.SSSSSS')
    .add(tradingViewUseOnlyWithin, 'minutes');
  const currentTime = moment.utc();
  if (tradingViewUpdatedAt.isBefore(currentTime)) {
    if (tradingViewIfExpires === 'do-not-buy') {
      logger.info(
        {
          tradingViewUpdatedAt: tradingViewUpdatedAt.format(),
          currentTime: currentTime.format()
        },
        `TradingView data is older than ${tradingViewUseOnlyWithin} minutes. Do not buy.`
      );
      return {
        isTradingViewAllowed: false,
        tradingViewRejectedReason:
          `Do not place an order because ` +
          `TradingView data is older than ${tradingViewUseOnlyWithin} minutes.`
      };
    }

    logger.info(
      {
        tradingViewUpdatedAt: tradingViewUpdatedAt.format(),
        currentTime: currentTime.format()
      },
      `TradingView data is older than ${tradingViewUseOnlyWithin} minutes. Ignore TradingView recommendation.`
    );
    return { isTradingViewAllowed: true, tradingViewRejectedReason: '' };
  }

  // Get allowed recommendation
  const allowedRecommendations = [];
  if (tradingViewWhenStrongBuy) {
    allowedRecommendations.push('strong_buy');
  }

  if (tradingViewWhenBuy) {
    allowedRecommendations.push('buy');
  }

  // If summary recommendation is not allowed recommendation, then prevent buy
  if (
    allowedRecommendations.length > 0 &&
    allowedRecommendations.includes(
      tradingViewSummaryRecommendation.toLowerCase()
    ) === false
  ) {
    return {
      isTradingViewAllowed: false,
      tradingViewRejectedReason:
        `Do not place an order because ` +
        `TradingView recommendation is ${tradingViewSummaryRecommendation}.`
    };
  }

  if (notifyDebug) {
    const humanisedGridTradeIndex = currentGridTradeIndex + 1;
    slack.sendMessage(
      `${symbol} Buy Action Grid Trade #${humanisedGridTradeIndex} (${moment().format(
        'HH:mm:ss.SSS'
      )}): TradingView Recommendation ${tradingViewSummaryRecommendation}\n` +
        `- Current API Usage: ${getAPILimit(logger)}`
    );
  }

  // Otherwise, simply allow
  return { isTradingViewAllowed: true, tradingViewRejectedReason: '' };
};

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
  data.buy.updatedAt = moment().utc();
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
      symbols,
      buy: { enabled: tradingEnabled, currentGridTradeIndex, currentGridTrade },
      system: { checkOrderExecutePeriod }
    },
    action,
    quoteAssetBalance: { free: quoteAssetFreeBalance },
    buy: { currentPrice, triggerPrice, openOrders },
    tradingView,
    overrideData
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
    isAllowedTradingViewRecommendation(logger, data);
  if (isTradingViewAllowed === false) {
    await saveOverrideAction(
      logger,
      symbol,
      {
        action: 'buy',
        actionAt: moment().add(1, 'minutes').format(),
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
    tradingView: {
      request: _.get(tradingView, 'request', {}),
      result: {
        time: _.get(tradingView, 'result.time', ''),
        summary: _.get(tradingView, 'result.summary', {})
      }
    },
    overrideData
  };

  const notifyMessage = { orderParams };
  if (notifyDebug) {
    notifyMessage.calculationParams = calculationParams;
  }

  slack.sendMessage(
    `${symbol} Buy Action Grid Trade #${humanisedGridTradeIndex} (${moment().format(
      'HH:mm:ss.SSS'
    )}): *STOP_LOSS_LIMIT*\n` +
      `- Order Params: \n` +
      `\`\`\`${JSON.stringify(notifyMessage, undefined, 2)}\`\`\`\n` +
      `- Current API Usage: ${getAPILimit(logger)}`
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
    currentGridTradeIndex,
    nextCheck: moment().add(checkOrderExecutePeriod, 'seconds').format()
  });

  // Save number of open orders
  await saveOrderStats(logger, symbols);

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

  return setMessage(
    logger,
    data,
    `Placed new stop loss limit order for buying of grid trade #${humanisedGridTradeIndex}.`
  );
};

module.exports = { execute };
