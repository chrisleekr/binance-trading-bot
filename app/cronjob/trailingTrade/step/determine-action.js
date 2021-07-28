const moment = require('moment');
const _ = require('lodash');
const config = require('config');
const { isActionDisabled } = require('../../trailingTradeHelper/common');
const { cache } = require('../../../helpers');

const retrieveLastBuyOrder = async symbol => {
  const cachedLastBuyOrder =
    JSON.parse(await cache.get(`${symbol}-last-buy-order`)) || {};

  return _.isEmpty(cachedLastBuyOrder);
};

/**
 * Check whether can buy or not
 *
 * @param {*} data
 * @returns
 */
const canBuy = async data => {
  const {
    buy: {
      currentPrice: buyCurrentPrice,
      triggerPrice: buyTriggerPrice,
      trend: { signedTrendDiff }
    },
    symbolConfiguration: {
      strategyOptions: {
        tradeOptions: { manyBuys, differenceToBuy },
        huskyOptions: { buySignal }
      }
    },
    sell: { lastBuyPrice, lastQtyBought },
    symbol
  } = data;

  const canBuyIt = await retrieveLastBuyOrder(symbol);

  let percentDifference = 200;

  if (buySignal) {
    if (manyBuys) {
      if (lastBuyPrice > 0) {
        percentDifference =
          100 *
          ((lastBuyPrice - buyCurrentPrice) /
            ((lastBuyPrice + buyCurrentPrice) / 2));
      }
      return (
        canBuyIt &&
        buyCurrentPrice <= buyTriggerPrice &&
        signedTrendDiff === 1 &&
        percentDifference >= differenceToBuy
      );
    }
    return (
      canBuyIt &&
      lastBuyPrice <= 0 &&
      lastQtyBought <= 0 &&
      buyCurrentPrice <= buyTriggerPrice &&
      signedTrendDiff === 1
    );
  }
  if (manyBuys) {
    if (lastBuyPrice > 0) {
      percentDifference =
        100 *
        ((lastBuyPrice - buyCurrentPrice) /
          ((lastBuyPrice + buyCurrentPrice) / 2));
    }
    return (
      canBuyIt &&
      buyCurrentPrice <= buyTriggerPrice &&
      percentDifference >= differenceToBuy
    );
  }
  return (
    canBuyIt &&
    lastBuyPrice <= 0 &&
    lastQtyBought <= 0 &&
    buyCurrentPrice <= buyTriggerPrice
  );
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
      strategyOptions: {
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
    buy: { currentPrice: buyCurrentPrice },
    sell: { lastQtyBought }
  } = data;

  return lastQtyBought * buyCurrentPrice >= parseFloat(minNotional);
};

/**
 * Check whether prediction is correct
 *
 * @param {*} data
 * @returns
 */
const predictedValueIsTrue = data => {
  const {
    buy: {
      prediction,
      difference,
      trend: { trendDiff, signedTrendDiff },
      currentPrice
    },
    symbolConfiguration: {
      buy: { predictValue }
    }
  } = data;

  if (!predictValue) {
    return false;
  }

  let predictionDiff =
    100 -
    (currentPrice /
      prediction.predictedValue[prediction.predictedValue.length - 1]) *
      100;
  if (Math.sign(predictionDiff) === -1) {
    predictionDiff *= -1;
  }
  return (
    predictionDiff >= 0.35 &&
    // Math.sign(prediction.predictedValue - currentPrice) === 1 &&
    difference >= 0.15 &&
    trendDiff >= 0.1 &&
    signedTrendDiff === 1
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
    symbolConfiguration: {
      buy: { lastBuyPriceRemoveThreshold }
    },
    sell: { currentPrice: sellCurrentPrice, lastBuyPrice, lastQtyBought },
    baseAssetBalance: { total: baseAssetTotalBalance }
  } = data;

  return (
    lastBuyPrice > 0 &&
    lastQtyBought * sellCurrentPrice > parseFloat(minNotional) &&
    lastQtyBought * sellCurrentPrice > lastBuyPriceRemoveThreshold &&
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
    buy: {
      trend: { signedTrendDiff }
    },
    sell: { currentPrice: sellCurrentPrice, triggerPrice: sellTriggerPrice },
    symbolConfiguration: {
      strategyOptions: {
        huskyOptions: { sellSignal }
      }
    }
  } = data;

  if (sellSignal) {
    return sellCurrentPrice >= sellTriggerPrice && signedTrendDiff === -1;
  }
  return sellCurrentPrice >= sellTriggerPrice;
};

const isHigherThanHardSellTriggerPrice = data => {
  const {
    sell: {
      currentPrice: sellCurrentPrice,
      hardTriggerPrice: hardSellTriggerPrice
    }
  } = data;

  return sellCurrentPrice >= hardSellTriggerPrice;
};

const isHigherThanSellTriggerPriceAndTrendIsDown = data => {
  const {
    indicators: {
      trend: { signedTrendDiff }
    },
    sell: { currentPrice: sellCurrentPrice, triggerPrice: sellTriggerPrice },
    symbolConfiguration: {
      strategyOptions: {
        huskyOptions: { sellSignal }
      }
    }
  } = data;

  return (
    sellCurrentPrice >= sellTriggerPrice && signedTrendDiff === -1 && sellSignal
  );
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
      buy: { predictValue },
      sell: {
        stopLoss: { enabled: sellStopLossEnabled }
      }
    },
    buy: {
      prediction,
      trend: { trendDiff }
    },
    sell: {
      currentPrice: sellCurrentPrice,
      stopLossTriggerPrice: sellStopLossTriggerPrice
    }
  } = data;
  /* if (predictValue) {
    const predictionDiff =
      100 -
      (sellCurrentPrice /
        prediction.predictedValue[prediction.predictedValue.length - 1]) *
        100;
    return (
      sellStopLossEnabled === true &&
      sellCurrentPrice <= sellStopLossTriggerPrice &&
      trendDiff <= 0.5 &&
      predictionDiff <= 0.5 &&
      prediction.predictedValue[prediction.predictedValue.length - 1] <=
        sellStopLossTriggerPrice
    );
  }
 */ return (
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
    symbolConfiguration: {
      sell: { trendDownMarketSell },
      strategyOptions: {
        tradeOptions: { manyBuys }
      }
    }
  } = data;

  if (_.isEmpty(data.buy) || _.isEmpty(data.buy.trend)) {
    return data;
  }

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
  const {
    coin_wrapper: { _actions }
  } = require(`../../../../public/${language}.json`);

  // Check buy signal -
  //  if last buy price is less than 0
  //    and current price is less or equal than lowest price
  //    and current balance has not enough value to sell,
  //  then buy.

  if (predictedValueIsTrue(data)) {
    if (!hasBalanceToSell(data)) {
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
          `${
            _actions.action_buy_disabled[1] +
            _actions.action_sell_disabled[2] +
            checkDisable.disabledBy
          }.${_actions.action_sell_disabled[3]}${checkDisable.ttl}s`
        );
      }

      return setBuyActionAndMessage(logger, data, 'buy', _actions.action_buy);
    }
  }
  if (await canBuy(data)) {
    // ATH verify
    if (isGreaterThanTheATHRestrictionPrice(data)) {
      return setBuyActionAndMessage(
        logger,
        data,
        'wait',
        `The current price has reached the lowest price; however, it is restricted to buy the coin.`
      );
    }

    if (manyBuys) {
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
          `${
            _actions.action_buy_disabled[1] +
            _actions.action_sell_disabled[2] +
            checkDisable.disabledBy
          }.${_actions.action_sell_disabled[3]}${checkDisable.ttl}s`
        );
      }

      logger.info('Buying again!.');

      return setBuyActionAndMessage(logger, data, 'buy', _actions.action_buy);
    }
    if (!hasBalanceToSell(data)) {
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
          `${
            _actions.action_buy_disabled[1] +
            _actions.action_sell_disabled[2] +
            checkDisable.disabledBy
          }.${_actions.action_sell_disabled[3]}${checkDisable.ttl}s`
        );
      }

      return setBuyActionAndMessage(logger, data, 'buy', _actions.action_buy);
    }
  }

  // Check sell signal - if
  //  last buy price has a value
  //  and total balance is enough to sell
  if (canSell(data)) {
    // And its above the HARD sell trigger.
    if (isHigherThanHardSellTriggerPrice(data)) {
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
          `${
            _actions.action_sell_disabled[1] +
            _actions.action_sell_disabled[2] +
            checkDisable.disabledBy
          }.${_actions.action_sell_disabled[3]}${checkDisable.ttl}s`
        );
      }
      if (trendDownMarketSell) {
        // Then sell market order
        return setSellActionAndMessage(
          logger,
          data,
          'sell-profit',
          'Selling because of hard profit. At market order.'
        );
      }
      // Then sell limit order
      return setSellActionAndMessage(
        logger,
        data,
        'sell',
        'Selling because of hard profit. At limit order.'
      );
    }

    if (isHigherThanSellTriggerPriceAndTrendIsDown(data)) {
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
          `${
            _actions.action_sell_disabled[1] +
            _actions.action_sell_disabled[2] +
            checkDisable.disabledBy
          }.${_actions.action_sell_disabled[3]}${checkDisable.ttl}s`
        );
      }
      if (trendDownMarketSell) {
        // Then sell market order
        return setSellActionAndMessage(
          logger,
          data,
          'sell-profit',
          'Selling because trend is down and current price is higher than defined profit. Market Order.'
        );
      }
      // Sell at limit order
      return setSellActionAndMessage(
        logger,
        data,
        'sell',
        'Selling because trend is down and current price is higher than defined profit. Limit order.'
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
          `${
            _actions.action_sell_disabled[1] +
            _actions.action_sell_disabled[2] +
            checkDisable.disabledBy
          }.${_actions.action_sell_disabled[3]}${checkDisable.ttl}s`
        );
      }
      // Then sell
      return setSellActionAndMessage(
        logger,
        data,
        'sell',
        _actions.action_sell
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
          `${
            _actions.action_sell_disabled_stop_loss[1] +
            _actions.action_sell_disabled_stop_loss[2] +
            checkDisable.disabledBy
          }.${_actions.action_sell_disabled_stop_loss[3]}${checkDisable.ttl}s`
        );
      }
      // Then sell market order
      return setSellActionAndMessage(
        logger,
        data,
        'sell-stop-loss',
        _actions.action_sell_stop_loss
      );
    }

    // otherwise, wait
    return setSellActionAndMessage(
      logger,
      data,
      'sell-wait',
      _actions.sell_wait
    );
  }

  // If cannot buy/sell, then just return data
  return data;
};

module.exports = { execute };
