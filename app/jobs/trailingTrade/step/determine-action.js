const moment = require('moment');

/**
 * Determine action for buy
 *
 * @param {*} logger
 * @param {*} rawData
 */
const execute = async (logger, rawData) => {
  const data = rawData;

  const {
    action,
    symbolInfo: {
      filterMinNotional: { minNotional }
    },
    baseAssetBalance: { total: baseAssetTotalBalance },
    buy: { currentPrice: buyCurrentPrice, triggerPrice: buyTriggerPrice },
    sell: {
      currentPrice: sellCurrentPrice,
      lastBuyPrice,
      triggerPrice: sellTriggerPrice
    }
  } = data;

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
  if (lastBuyPrice <= 0 && buyCurrentPrice <= buyTriggerPrice) {
    if (baseAssetTotalBalance * buyCurrentPrice < parseFloat(minNotional)) {
      logger.info(
        { buyCurrentPrice, buyTriggerPrice },
        "The current price reached the trigger price. Let's buy it."
      );
      data.action = 'buy';
      data.buy.processMessage =
        "The current price reached the trigger price. Let's buy it.";
      data.buy.updatedAt = moment().utc();
      return data;
    }

    logger.info(
      { buyCurrentPrice, buyTriggerPrice },
      `The current price reached the trigger price. But has enough to sell. Hence, do not buy it.`
    );
    data.action = 'wait';
    data.buy.processMessage =
      'The current price reached the trigger price. But has enough to sell. Hence, do not buy it.';
    data.buy.updatedAt = moment().utc();
    return data;
  }

  // Check sell signal - if
  //  last buy price has a value
  //  and total balance is enough to sell
  if (
    lastBuyPrice > 0 &&
    baseAssetTotalBalance * sellCurrentPrice > parseFloat(minNotional)
  ) {
    // And if current price is higher or equal than trigger price,
    if (sellCurrentPrice >= sellTriggerPrice) {
      // Then sell
      logger.info(
        { sellCurrentPrice, sellTriggerPrice },
        "The current price is more than the trigger price. Let's sell."
      );
      data.action = 'sell';
      data.sell.processMessage =
        "The current price is more than the trigger price. Let's sell.";
      data.sell.updatedAt = moment().utc();
    } else {
      // otherwise, wait
      logger.info(
        { sellCurrentPrice, sellTriggerPrice },
        'The current price is lower than the selling trigger price. Wait.'
      );

      data.action = 'sell-wait';
      data.sell.processMessage =
        'The current price is lower than the selling trigger price. Wait.';
      data.sell.updatedAt = moment().utc();
    }

    return data;
  }

  return data;
};

module.exports = { execute };
