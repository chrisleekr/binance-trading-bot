const _ = require('lodash');
const moment = require('moment');
const { slack } = require('../../../helpers');

const {
  isActionDisabled,
  getNumberOfBuyOpenOrders,
  isExceedingMaxOpenTrades,
  getAPILimit
} = require('../../trailingTradeHelper/common');
const { getGridTradeOrder } = require('../../trailingTradeHelper/order');

/**
 * Check whether current price is lower or equal than stop loss trigger price
 *
 * @param {*} data
 * @returns
 */
const isLowerThanStopLossTriggerPrice = data => {
  const {
    symbolConfiguration: {
      sell: {
        stopLoss: { enabled: sellStopLossEnabled }
      }
    },
    sell: {
      currentPrice: sellCurrentPrice,
      stopLossTriggerPrice: sellStopLossTriggerPrice
    }
  } = data;

  return (
    sellStopLossEnabled === true && sellCurrentPrice <= sellStopLossTriggerPrice
  );
};

/**
 * Check whether can buy or not
 *
 *  - current price must be less than trigger price.
 *  - current grid trade must be defined.
 *
 * @param {*} data
 * @returns
 */
const canBuy = data => {
  const {
    symbolConfiguration: {
      buy: { currentGridTrade }
    },
    buy: { currentPrice: buyCurrentPrice, triggerPrice: buyTriggerPrice }
  } = data;

  return (
    buyCurrentPrice <= buyTriggerPrice &&
    currentGridTrade !== null &&
    !isLowerThanStopLossTriggerPrice(data)
  );
};

/**
 * Check whether has enough balance to sell
 *
 *  - If current gird trade index is 0, and has enough balance to sell,
 *    then it should not execute
 *
 * @param {*} data
 * @returns
 */
const hasBalanceToSell = data => {
  const {
    symbolInfo: {
      filterMinNotional: { minNotional }
    },
    baseAssetBalance: { total: baseAssetTotalBalance },
    buy: { currentPrice: buyCurrentPrice },
    symbolConfiguration: {
      buy: { currentGridTradeIndex: currentBuyGridTradeIndex }
    }
  } = data;

  return (
    currentBuyGridTradeIndex === 0 &&
    baseAssetTotalBalance * buyCurrentPrice >= parseFloat(minNotional)
  );
};

/**
 * Check whether trigger price within the buying restriction price or not
 *
 *  - current grid trade must be first grid trade.
 *  - ATH restriction must be enabled.
 *  - buy trigger price must be higher than ATH restriction price.
 *
 * @param {*} data
 * @returns
 */
const isGreaterThanTheATHRestrictionPrice = data => {
  const {
    symbolConfiguration: {
      buy: {
        currentGridTradeIndex,
        athRestriction: { enabled: buyATHRestrictionEnabled }
      }
    },
    buy: {
      triggerPrice: buyTriggerPrice,
      athRestrictionPrice: buyATHRestrictionPrice
    }
  } = data;

  return (
    currentGridTradeIndex === 0 &&
    buyATHRestrictionEnabled === true &&
    buyTriggerPrice >= buyATHRestrictionPrice
  );
};

/**
 * Check whether current open orders has reached maximum open orders
 *
 *  - current buy open order must be less than maximum buy open orders.
 *
 * @param {*} logger
 * @param {*} data
 * @returns
 */
const isExceedingMaxBuyOpenOrders = async (logger, data) => {
  const {
    symbolConfiguration: {
      botOptions: {
        orderLimit: {
          enabled: orderLimitEnabled,
          maxBuyOpenOrders: orderLimitMaxBuyOpenOrders
        }
      }
    }
  } = data;

  if (orderLimitEnabled === false) {
    return false;
  }

  const currentBuyOpenOrders = await getNumberOfBuyOpenOrders(logger);

  if (currentBuyOpenOrders >= orderLimitMaxBuyOpenOrders) {
    return true;
  }

  return false;
};

/**
 * Set buy action and message
 *
 * @param {*} logger
 * @param {*} rawData
 * @param {*} action
 * @param {*} processMessage
 * @returns
 */
const setBuyActionAndMessage = (logger, rawData, action, processMessage) => {
  const data = rawData;

  data.action = action;
  data.buy.processMessage = processMessage;
  data.buy.updatedAt = moment().utc().toDate();

  logger.info({ data, saveLog: true }, processMessage);
  return data;
};

/**
 * Check whether can sell or not
 *
 *  - last buy price must be more than 0.
 *  - current balance must be more than the minimum notional value
 *  - current grid trade must not be null.
 *
 * @param {*} data
 * @returns
 */
const canSell = data => {
  const {
    symbolInfo: {
      filterMinNotional: { minNotional }
    },
    symbolConfiguration: {
      sell: { currentGridTrade }
    },
    baseAssetBalance: { total: baseAssetTotalBalance },
    sell: { currentPrice: sellCurrentPrice, lastBuyPrice }
  } = data;

  return (
    lastBuyPrice > 0 &&
    baseAssetTotalBalance * sellCurrentPrice > parseFloat(minNotional) &&
    currentGridTrade !== null
  );
};

/**
 * Check whether current price is higher than sell trigger price
 *
 * @param {*} data
 * @returns
 */
const isHigherThanSellTriggerPrice = data => {
  const {
    sell: { currentPrice: sellCurrentPrice, triggerPrice: sellTriggerPrice }
  } = data;

  return sellCurrentPrice >= sellTriggerPrice;
};

/**
 * Check whether should execute stop-loss if recommendation is neutral, sell or strong sell
 *
 * @param {*} logger
 * @param {*} data
 * @returns
 */
const shouldForceSellByTradingViewRecommendation = (logger, data) => {
  const {
    symbolInfo: {
      filterLotSize: { stepSize },
      filterMinNotional: { minNotional }
    },
    symbolConfiguration: {
      sell: {
        tradingView: {
          forceSellOverZeroBelowTriggerPrice: {
            whenNeutral: tradingViewForceSellWhenNeutral,
            whenSell: tradingViewForceSellWhenSell,
            whenStrongSell: tradingViewForceSellWhenStrongSell
          }
        }
      },
      botOptions: {
        tradingView: { useOnlyWithin: tradingViewUseOnlyWithin }
      }
    },
    baseAssetBalance: { free: baseAssetFreeBalance },
    sell: {
      currentProfit: sellCurrentProfit,
      currentPrice: sellCurrentPrice,
      triggerPrice: sellTriggerPrice
    },
    tradingView
  } = data;

  // If tradingView force sell configuration is not enabled, then no need to process.
  if (
    tradingViewForceSellWhenNeutral === false &&
    tradingViewForceSellWhenSell === false &&
    tradingViewForceSellWhenStrongSell === false
  ) {
    logger.info(
      { tradingViewForceSellWhenSell, tradingViewForceSellWhenStrongSell },
      'TradingView recommendation is not enabled.'
    );

    return { shouldForceSell: false, forceSellMessage: '' };
  }

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

    return { shouldForceSell: false, forceSellMessage: '' };
  }

  // If tradingViewTime is more than configured time, then ignore TradingView recommendation.
  const tradingViewUpdatedAt = moment
    .utc(tradingViewTime, 'YYYY-MM-DDTHH:mm:ss.SSSSSS')
    .add(tradingViewUseOnlyWithin, 'minutes');
  const currentTime = moment.utc();
  if (tradingViewUpdatedAt.isBefore(currentTime)) {
    logger.info(
      {
        tradingViewUpdatedAt: tradingViewUpdatedAt.toISOString(),
        currentTime: currentTime.toISOString()
      },
      `TradingView data is older than ${tradingViewUseOnlyWithin} minutes. Ignore TradingView recommendation.`
    );

    return {
      shouldForceSell: false,
      forceSellMessage:
        `TradingView data is older than ${tradingViewUseOnlyWithin} minutes. ` +
        `Ignore TradingView recommendation.`
    };
  }

  // If current profit is less than 0 or current price is more than trigger price
  if (sellCurrentProfit <= 0 || sellCurrentPrice > sellTriggerPrice) {
    logger.info(
      { sellCurrentProfit, sellCurrentPrice, sellTriggerPrice },
      `Current profit if equal or less than 0 or ` +
        `current price is more than trigger price. Ignore TradingView recommendation.`
    );

    return { shouldForceSell: false, forceSellMessage: '' };
  }

  // Only execute when the free balance is more than minimum notional value.
  const lotPrecision = parseFloat(stepSize) === 1 ? 0 : stepSize.indexOf(1) - 1;
  const freeBalance = parseFloat(_.floor(baseAssetFreeBalance, lotPrecision));
  const orderQuantity = parseFloat(
    _.floor(freeBalance - freeBalance * (0.1 / 100), lotPrecision)
  );

  if (orderQuantity * sellCurrentPrice < parseFloat(minNotional)) {
    logger.info(
      { sellCurrentProfit, sellCurrentPrice, sellTriggerPrice },
      'Order quantity is less than minimum notional value. Ignore TradingView recommendation.'
    );

    return { shouldForceSell: false, forceSellMessage: '' };
  }

  logger.info({ freeBalance }, 'Free balance');

  // Get force sell recommendation
  const forceSellRecommendations = [];
  if (tradingViewForceSellWhenNeutral) {
    forceSellRecommendations.push('neutral');
  }

  if (tradingViewForceSellWhenSell) {
    forceSellRecommendations.push('sell');
  }

  if (tradingViewForceSellWhenStrongSell) {
    forceSellRecommendations.push('strong_sell');
  }

  // If summary recommendation is force sell recommendation, then execute force sell
  if (
    forceSellRecommendations.length > 0 &&
    forceSellRecommendations.includes(
      tradingViewSummaryRecommendation.toLowerCase()
    ) === true
  ) {
    return {
      shouldForceSell: true,
      forceSellMessage:
        `TradingView recommendation is ${tradingViewSummaryRecommendation}. ` +
        `The current profit (${sellCurrentProfit}) is more than 0 and the current price (${sellCurrentPrice}) ` +
        `is under trigger price (${sellTriggerPrice}). Sell at market price.`
    };
  }

  // Otherwise, simply ignore
  return { shouldForceSell: false, forceSellMessage: '' };
};

/**
 * Set sell action and message
 *
 * @param {*} logger
 * @param {*} rawData
 * @param {*} action
 * @param {*} processMessage
 * @returns
 */
const setSellActionAndMessage = (logger, rawData, action, processMessage) => {
  const data = rawData;

  data.action = action;
  data.sell.processMessage = processMessage;
  data.sell.updatedAt = moment().utc().toDate();

  logger.info({ data, saveLog: true }, processMessage);
  return data;
};

/**
 * Retrieve last grid order from cache
 *
 * @param {*} logger
 * @param {*} symbol
 * @param {*} side
 * @returns
 */
const getGridTradeLastOrder = async (logger, symbol, side) => {
  const lastOrder =
    (await getGridTradeOrder(
      logger,
      `${symbol}-grid-trade-last-${side}-order`
    )) || {};

  logger.info(
    { lastOrder },
    `Retrieved grid trade last ${side} order from cache`
  );

  return lastOrder;
};

/**
 * Determine action for trade
 *
 * @param {*} logger
 * @param {*} rawData
 */
const execute = async (logger, rawData) => {
  const data = rawData;

  const {
    action,
    symbol,
    symbolInfo: { baseAsset },
    symbolConfiguration: {
      buy: { currentGridTradeIndex: currentBuyGridTradeIndex },
      sell: { currentGridTradeIndex: currentSellGridTradeIndex }
    }
  } = data;

  const humanisedBuyGridTradeIndex = currentBuyGridTradeIndex + 1;
  const humanisedSellGridTradeIndex = currentSellGridTradeIndex + 1;

  if (action !== 'not-determined') {
    logger.info(
      { action },
      'Action is already defined, do not try to determine action.'
    );
    return data;
  }

  // Check buy signal -
  //  if last buy price is less than 0
  //    and current price is less or equal than lowest price
  //    and current balance has not enough value to sell,
  //    and current price is lower than the restriction price
  //  then buy.
  if (canBuy(data)) {
    if (
      _.isEmpty(await getGridTradeLastOrder(logger, symbol, 'buy')) === false
    ) {
      return setBuyActionAndMessage(
        logger,
        data,
        'buy-order-wait',
        `There is a last gird trade buy order. Wait.`
      );
    }

    if (hasBalanceToSell(data)) {
      return setBuyActionAndMessage(
        logger,
        data,
        'wait',
        `The current price reached the trigger price. ` +
          `But you have enough ${baseAsset} to sell. ` +
          `Set the last buy price to start selling. ` +
          `Do not process buy.`
      );
    }

    const checkDisable = await isActionDisabled(symbol);
    logger.info(
      { tag: 'check-disable', checkDisable },
      'Checked whether symbol is disabled or not.'
    );
    if (checkDisable.isDisabled) {
      return setBuyActionAndMessage(
        logger,
        data,
        'buy-temporary-disabled',
        'The current price reached the trigger price. ' +
          `However, the action is temporarily disabled by ${checkDisable.disabledBy}. ` +
          `Resume buy process after ${checkDisable.ttl}s.`
      );
    }

    if (isGreaterThanTheATHRestrictionPrice(data)) {
      return setBuyActionAndMessage(
        logger,
        data,
        'wait',
        `The current price has reached the lowest price; however, it is restricted to buy the coin ` +
          `because ATH price higher than the current price.`
      );
    }

    if (await isExceedingMaxBuyOpenOrders(logger, data)) {
      return setBuyActionAndMessage(
        logger,
        data,
        'wait',
        `The current price has reached the lowest price; however, it is restricted to buy the coin ` +
          `because of reached maximum buy open orders.`
      );
    }

    if (await isExceedingMaxOpenTrades(logger, data)) {
      return setBuyActionAndMessage(
        logger,
        data,
        'wait',
        `The current price has reached the lowest price; however, it is restricted to buy the coin ` +
          `because of reached maximum open trades.`
      );
    }

    return setBuyActionAndMessage(
      logger,
      data,
      'buy',
      `The current price reached the trigger price for the grid trade #${humanisedBuyGridTradeIndex}. Let's buy it.`
    );
  }

  // Check sell signal - if
  //  last buy price has a value
  //  and total balance is enough to sell
  if (canSell(data)) {
    if (
      _.isEmpty(await getGridTradeLastOrder(logger, symbol, 'sell')) === false
    ) {
      return setSellActionAndMessage(
        logger,
        data,
        'sell-order-wait',
        `There is a last gird trade sell order. Wait.`
      );
    }

    // If tradingView recommendation is sell or strong sell
    const { shouldForceSell, forceSellMessage } =
      shouldForceSellByTradingViewRecommendation(logger, data);
    if (shouldForceSell) {
      // Prevent disable by stop-loss
      data.canDisable = false;

      // Notify as it's important message for now.
      // Eventually, should convert to logging to reduce unnecessary notifications.
      slack.sendMessage(
        `*${symbol}* Action - *Force sell*: \n- Message: ${forceSellMessage}`,
        { symbol, apiLimit: getAPILimit(logger) }
      );

      // Then sell market order
      return setSellActionAndMessage(
        logger,
        data,
        'sell-stop-loss',
        forceSellMessage
      );
    }

    // If current price is higher or equal than trigger price
    if (isHigherThanSellTriggerPrice(data)) {
      const checkDisable = await isActionDisabled(symbol);
      logger.info(
        { tag: 'check-disable', checkDisable },
        'Checked whether symbol is disabled or not.'
      );
      if (checkDisable.isDisabled) {
        return setSellActionAndMessage(
          logger,
          data,
          'sell-temporary-disabled',
          'The current price is reached the sell trigger price. ' +
            `However, the action is temporarily disabled by ${checkDisable.disabledBy}. ` +
            `Resume sell process after ${checkDisable.ttl}s.`
        );
      }

      // Then sell
      return setSellActionAndMessage(
        logger,
        data,
        'sell',
        "The current price is more than the trigger price. Let's sell."
      );
    }

    if (isLowerThanStopLossTriggerPrice(data)) {
      const checkDisable = await isActionDisabled(symbol);
      logger.info(
        { tag: 'check-disable', checkDisable },
        'Checked whether symbol is disabled or not.'
      );
      if (checkDisable.isDisabled) {
        return setSellActionAndMessage(
          logger,
          data,
          'sell-temporary-disabled',
          'The current price is reached the stop-loss price. ' +
            `However, the action is temporarily disabled by ${checkDisable.disabledBy}. ` +
            `Resume sell process after ${checkDisable.ttl}s.`
        );
      }

      // Then sell market order
      return setSellActionAndMessage(
        logger,
        data,
        'sell-stop-loss',
        'The current price is reached the stop-loss price. Place market sell order.'
      );
    }

    // otherwise, wait
    return setSellActionAndMessage(
      logger,
      data,
      'sell-wait',
      `The current price is lower than the selling trigger price ` +
        `for the grid trade #${humanisedSellGridTradeIndex}. Wait.`
    );
  }

  // If cannot buy/sell, then just return data
  return data;
};

module.exports = { execute };
