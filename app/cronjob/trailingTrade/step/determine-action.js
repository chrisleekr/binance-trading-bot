const moment = require('moment');

const { isActionDisabled } = require('../../trailingTradeHelper/common');

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
 * Check whether trigger price within the buying restriction price or not
 *
 * @param {*} data
 * @returns
 */
const isGreaterThanTheATHRestrictionPrice = data => {
  const {
    symbolConfiguration: {
      buy: {
        athRestriction: { enabled: buyATHRestrictionEnabled }
      }
    },
    buy: {
      triggerPrice: buyTriggerPrice,
      athRestrictionPrice: buyATHRestrictionPrice
    }
  } = data;

  return (
    buyATHRestrictionEnabled === true &&
    buyTriggerPrice >= buyATHRestrictionPrice
  );
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
    symbolInfo: { baseAsset }
  } = data;

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
      'The current price is lower than the selling trigger price. Wait.'
    );
  }

  // If cannot buy/sell, then just return data
  return data;
};

module.exports = { execute };
