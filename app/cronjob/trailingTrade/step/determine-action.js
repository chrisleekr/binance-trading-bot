const moment = require('moment');
const _ = require('lodash');
const { isActionDisabled } = require('../../trailingTradeHelper/common');
const config = require('config');
const { cache } = require('../../../helpers');


const retrieveLastBuyOrder = async (symbol) => {
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
const canBuy = async (data) => {
  const {
    buy: { currentPrice: buyCurrentPrice, triggerPrice: buyTriggerPrice },
    indicators: { trendDiff },
    symbolConfiguration: { strategyOptions: { tradeOptions: { manyBuys, differenceToBuy }, huskyOptions: { buySignal } } },
    sell: { lastBuyPrice, lastQtyBought },
    symbol
  } = data;

  const canBuy = await retrieveLastBuyOrder(symbol);

  let percDiff = 200;


  if (buySignal) {
    if (manyBuys) {
      if (lastBuyPrice > 0) {
        percDiff = 100 * ((lastBuyPrice - buyCurrentPrice) / ((lastBuyPrice + buyCurrentPrice) / 2));
      }
      return canBuy &&
        buyCurrentPrice <= buyTriggerPrice &&
        Math.sign(trendDiff) == 1 &&
        percDiff >= differenceToBuy
    } else {
      return canBuy &&
        lastBuyPrice <= 0 &&
        lastQtyBought <= 0 &&
        buyCurrentPrice <= buyTriggerPrice &&
        Math.sign(trendDiff) == 1;
    }
  } else {
    if (manyBuys) {
      if (lastBuyPrice > 0) {
        percDiff = 100 * ((lastBuyPrice - buyCurrentPrice) / ((lastBuyPrice + buyCurrentPrice) / 2));
      }
      return canBuy &&
        buyCurrentPrice <= buyTriggerPrice &&
        percDiff >= differenceToBuy
    } else {
      return canBuy &&
        lastBuyPrice <= 0 &&
        lastQtyBought <= 0 &&
        buyCurrentPrice <= buyTriggerPrice;
    }
  }

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
 * Check whether current price difference is higher than defined, to buy again
 *
 * @param {*} data
 * @returns
 */
const currentPriceIsHigherThanDifferenceToBuy = data => {
  const {
    buy: { currentPrice: buyCurrentPrice },
    sell: { lastBuyPrice },
    symbolConfiguration: { strategyOptions: { tradeOptions: { manyBuys, differenceToBuy } } }
  } = data;

  if (lastBuyPrice == 0 || lastBuyPrice == null || manyBuys == false) {
    return false;
  }

  const percDiff = 100 * ((lastBuyPrice - buyCurrentPrice) / ((lastBuyPrice + buyCurrentPrice) / 2));

  return percDiff >= differenceToBuy;
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
    sell: { currentPrice: sellCurrentPrice, triggerPrice: sellTriggerPrice },
    symbolConfiguration: { strategyOptions: { huskyOptions: { sellSignal } } }
  } = data;

  if (sellSignal) {
    return sellCurrentPrice >= sellTriggerPrice && Math.sign(data.indicators.trendDiff) == -1
  } else {
    return sellCurrentPrice >= sellTriggerPrice;
  }
};

const isHigherThanHardSellTriggerPrice = data => {
  const {
    sell: { currentPrice: sellCurrentPrice, hardTriggerPrice: hardSellTriggerPrice }
  } = data;

  return sellCurrentPrice >= hardSellTriggerPrice
};

const isHigherThanSellTriggerPriceAndTrendIsDown = data => {
  const {
    sell: { currentPrice: sellCurrentPrice, triggerPrice: sellTriggerPrice },
    symbolConfiguration: { strategyOptions: { huskyOptions: { sellSignal } } }
  } = data;

  return sellCurrentPrice >= sellTriggerPrice && Math.sign(data.indicators.trendDiff) == -1 && sellSignal;
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
    symbolConfiguration: { sell: { trendDownMarketSell }, strategyOptions: { tradeOptions: { manyBuys } } }
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
  const { coin_wrapper: { _actions } } = require(`../../../../public/${language}.json`);

  // Check buy signal -
  //  if last buy price is less than 0
  //    and current price is less or equal than lowest price
  //    and current balance has not enough value to sell,
  //  then buy.
  if (await canBuy(data)) {
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
          _actions.action_buy_disabled[1] +
          _actions.action_sell_disabled[2] + checkDisable.disabledBy + '.' +
          _actions.action_sell_disabled[3] + checkDisable.ttl + 's'
        );
      }

      logger.info(
        "Buying again!."
      );


      return setBuyActionAndMessage(
        logger,
        data,
        'buy',
        _actions.action_buy
      );
    } else {
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
            _actions.action_buy_disabled[1] +
            _actions.action_sell_disabled[2] + checkDisable.disabledBy + '.' +
            _actions.action_sell_disabled[3] + checkDisable.ttl + 's'
          );
        }

        return setBuyActionAndMessage(
          logger,
          data,
          'buy',
          _actions.action_buy
        );
      }
    }
  }

  // Check sell signal - if
  //  last buy price has a value
  //  and total balance is enough to sell
  if (canSell(data)) {

    //And its above the HARD sell trigger.
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
          _actions.action_sell_disabled[1] +
          _actions.action_sell_disabled[2] + checkDisable.disabledBy + '.' +
          _actions.action_sell_disabled[3] + checkDisable.ttl + 's'
        );
      }
      if (trendDownMarketSell) {
        // Then sell market order
        return setSellActionAndMessage(
          logger,
          data,
          'sell-profit',
          "Selling because of hard profit. At market order."
        );
      } else {
        // Then sell limit order
        return setSellActionAndMessage(
          logger,
          data,
          'sell',
          "Selling because of hard profit. At limit order."
        );
      }

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
          _actions.action_sell_disabled[1] +
          _actions.action_sell_disabled[2] + checkDisable.disabledBy + '.' +
          _actions.action_sell_disabled[3] + checkDisable.ttl + 's'
        );
      }
      if (trendDownMarketSell) {
        // Then sell market order
        return setSellActionAndMessage(
          logger,
          data,
          'sell-profit',
          "Selling because trend is down and current price is higher than defined profit. Market Order."
        );
      } else {
        //Sell at limit order
        return setSellActionAndMessage(
          logger,
          data,
          'sell',
          "Selling because trend is down and current price is higher than defined profit. Limit order."
        );
      }
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
          _actions.action_sell_disabled[1] +
          _actions.action_sell_disabled[2] + checkDisable.disabledBy + '.' +
          _actions.action_sell_disabled[3] + checkDisable.ttl + 's'
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
          _actions.action_sell_disabled_stop_loss[1] +
          _actions.action_sell_disabled_stop_loss[2] + checkDisable.disabledBy + '.' +
          _actions.action_sell_disabled_stop_loss[3] + checkDisable.ttl + 's'
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
