const moment = require('moment');

const { isActionDisabled } = require('../../trailingTradeHelper/common');
const config = require('config');

/**
 * Check whether can buy or not
 *
 * @param {*} data
 * @returns
 */
const canBuy = data => {
  const {
    buy: { currentPrice: buyCurrentPrice, triggerPrice: buyTriggerPrice },
    sell: { lastBuyPrice },
    indicators: { trendDiff }
  } = data;

  return lastBuyPrice <= 0 && buyCurrentPrice <= buyTriggerPrice &&
    Math.sign(trendDiff) != -1;
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
    symbolConfiguration: {
      buy: { lastBuyPriceRemoveThreshold }
    },
    baseAssetBalance: { total: baseAssetTotalBalance },
    sell: { currentPrice: sellCurrentPrice, lastBuyPrice }
  } = data;

  return (
    lastBuyPrice > 0 &&
    baseAssetTotalBalance * sellCurrentPrice > parseFloat(minNotional) &&
    baseAssetTotalBalance * sellCurrentPrice > lastBuyPriceRemoveThreshold
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


  const language = config.get('language');
  const { coinWrapper: { actions } } = require(`../../../../public/${language}.json`);

  // messenger.errorMessage("pora2" + json)

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
        actions.action_wait[1] +
        actions.action_wait[2] + baseAsset + actions.action_wait[3] +
        actions.action_wait[4] +
        actions.action_wait[5]
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
        actions.action_buy_disabled[1] +
        actions.action_sell_disabled[2] + checkDisable.disabledBy + '.' +
        actions.action_sell_disabled[3] + checkDisable.ttl + 's'
      );
    }

    return setBuyActionAndMessage(
      logger,
      data,
      'buy',
      actions.action_buy
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
          actions.action_sell_disabled[1] +
          actions.action_sell_disabled[2] + checkDisable.disabledBy + '.' +
          actions.action_sell_disabled[3] + checkDisable.ttl + 's'
        );
      }
      // Then sell
      return setSellActionAndMessage(
        logger,
        data,
        'sell',
        actions.action_sell
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
          actions.action_sell_disabled_stop_loss[1] +
          actions.action_sell_disabled_stop_loss[2] + checkDisable.disabledBy + '.' +
          actions.action_sell_disabled_stop_loss[3] + checkDisable.ttl + 's'
        );
      }
      // Then sell market order
      return setSellActionAndMessage(
        logger,
        data,
        'sell-stop-loss',
        actions.action_sell_stop_loss
      );
    }

    // otherwise, wait
    return setSellActionAndMessage(
      logger,
      data,
      'sell-wait',
      actions.sell_wait
    );
  }

  // If cannot buy/sell, then just return data
  return data;
};

module.exports = { execute };
