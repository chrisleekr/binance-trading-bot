const moment = require('moment');

/**
 * Check whether can buy or not
 *
 * @param {*} data
 * @returns
 */
const canBuy = data => {
  const {
    buy: { currentPrice: buyCurrentPrice, triggerPrice: buyTriggerPrice },
    sell: { lastBuyPrice }
  } = data;

  return lastBuyPrice <= 0 && buyCurrentPrice <= buyTriggerPrice;
};

/**
 * Check whether has enough balance to sell
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
    buy: { currentPrice: buyCurrentPrice }
  } = data;

  return baseAssetTotalBalance * buyCurrentPrice >= parseFloat(minNotional);
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

  logger.info({ data }, processMessage);
  data.action = action;
  data.buy.processMessage = processMessage;
  data.buy.updatedAt = moment().utc();
  return data;
};

/**
 * Check whether can sell or not
 *
 * @param {*} data
 * @returns
 */
const canSell = data => {
  const {
    symbolInfo: {
      filterMinNotional: { minNotional }
    },
    baseAssetBalance: { total: baseAssetTotalBalance },
    sell: { currentPrice: sellCurrentPrice, lastBuyPrice }
  } = data;

  return (
    lastBuyPrice > 0 &&
    baseAssetTotalBalance * sellCurrentPrice > parseFloat(minNotional)
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
 * Determine action for buy
 *
 * @param {*} logger
 * @param {*} rawData
 */
const execute = async (logger, rawData) => {
  const data = rawData;

  const { action, isLocked } = data;

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
  //  then buy.
  if (canBuy(data)) {
    if (hasBalanceToSell(data)) {
      return setBuyActionAndMessage(
        logger,
        data,
        'wait',
        'The current price reached the trigger price. But has enough to sell. Hence, do not buy it.'
      );
    }

    return setBuyActionAndMessage(
      logger,
      data,
      'buy',
      "The current price reached the trigger price. Let's buy it."
    );
  }

  // Check sell signal - if
  //  last buy price has a value
  //  and total balance is enough to sell
  if (canSell(data)) {
    // And if current price is higher or equal than trigger price,
    if (isHigherThanSellTriggerPrice(data)) {
      // Then sell
      return setSellActionAndMessage(
        logger,
        data,
        'sell',
        "The current price is more than the trigger price. Let's sell."
      );
    }

    // otherwise, wait
    return setSellActionAndMessage(
      logger,
      data,
      'sell-wait',
      'The current price is lower than the selling trigger price. Wait.'
    );
  }

  // If cannot buy/sell, then just return data
  return data;
};

module.exports = { execute };
