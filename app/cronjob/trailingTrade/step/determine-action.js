const _ = require('lodash');
const moment = require('moment');

const {
  isActionDisabled,
  getNumberOfBuyOpenOrders,
  getNumberOfOpenTrades
} = require('../../trailingTradeHelper/common');
const { getGridTradeOrder } = require('../../trailingTradeHelper/order');

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

  return buyCurrentPrice <= buyTriggerPrice && currentGridTrade !== null;
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

const isExceedingMaxOpenTrades = async (logger, data) => {
  const {
    symbolConfiguration: {
      botOptions: {
        orderLimit: {
          enabled: orderLimitEnabled,
          maxOpenTrades: orderLimitMaxOpenTrades
        }
      }
    },
    sell: { lastBuyPrice }
  } = data;

  if (orderLimitEnabled === false) {
    return false;
  }

  let currentOpenTrades = await getNumberOfOpenTrades(logger);

  // If the last buy price is recorded, this is one of open trades.
  // Deduct 1 from the current open trades and calculate it.
  if (lastBuyPrice) {
    currentOpenTrades -= 1;
  }

  if (currentOpenTrades >= orderLimitMaxOpenTrades) {
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

  logger.info({ tag: 'set-buy-action-and-message', data }, processMessage);
  data.action = action;
  data.buy.processMessage = processMessage;
  data.buy.updatedAt = moment().utc();
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

  logger.info({ data }, processMessage);
  data.action = action;
  data.sell.processMessage = processMessage;
  data.sell.updatedAt = moment().utc();
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
    isLocked,
    symbolInfo: { baseAsset },
    symbolConfiguration: {
      buy: { currentGridTradeIndex: currentBuyGridTradeIndex },
      sell: { currentGridTradeIndex: currentSellGridTradeIndex }
    }
  } = data;

  const humanisedBuyGridTradeIndex = currentBuyGridTradeIndex + 1;
  const humanisedSellGridTradeIndex = currentSellGridTradeIndex + 1;

  if (isLocked) {
    logger.info(
      { isLocked },
      'Symbol is locked, do not process determine-action'
    );
    return data;
  }

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
        `The current price has reached the lowest price; however, it is restricted to buy the coin.`
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
    // And if current price is higher or equal than trigger price
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
