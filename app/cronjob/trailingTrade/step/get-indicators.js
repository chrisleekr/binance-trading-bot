/* eslint-disable prefer-destructuring */
const _ = require('lodash');
const moment = require('moment');
const { cache } = require('../../../helpers');
const { getLastBuyPrice } = require('../../trailingTradeHelper/common');

/**
 * Get symbol information, buy/sell indicators
 *
 * @param {*} logger
 * @param {*} rawData
 */
const execute = async (logger, rawData) => {
  const data = rawData;

  const {
    symbol,
    symbolInfo: {
      filterMinNotional: { minNotional }
    },
    symbolConfiguration: {
      buy: {
        triggerPercentage: buyTriggerPercentage,
        limitPercentage: buyLimitPercentage,
        athRestriction: {
          enabled: buyATHRestrictionEnabled,
          restrictionPercentage: buyATHRestrictionPercentage
        }
      },
      sell: {
        triggerPercentage: sellTriggerPercentage,
        limitPercentage: sellLimitPercentage,
        stopLoss: { maxLossPercentage: sellMaxLossPercentage }
      }
    },
    baseAssetBalance: { total: baseAssetTotalBalance },
    openOrders
  } = data;

  const cachedIndicator =
    JSON.parse(
      await cache.hget('trailing-trade-symbols', `${symbol}-indicator-data`)
    ) || {};

  if (_.isEmpty(cachedIndicator)) {
    logger.info('Indicator data is not retrieved, wait for cache.');
    data.saveToCache = false;
    return data;
  }

  const cachedLatestCandle =
    JSON.parse(
      await cache.hget('trailing-trade-symbols', `${symbol}-latest-candle`)
    ) || {};

  if (_.isEmpty(cachedLatestCandle)) {
    logger.info('Last candle is not retrieved, wait for cache.');
    data.saveToCache = false;
    return data;
  }

  // Set last candle
  data.lastCandle = cachedLatestCandle;
  // Merge indicator data
  data.indicators = {
    ...data.indicators,
    ...cachedIndicator
  };

  // Cast string to number
  const { highestPrice, lowestPrice, athPrice } = data.indicators;
  const currentPrice = parseFloat(cachedLatestCandle.close);
  const buyTriggerPrice = lowestPrice * buyTriggerPercentage;
  const buyDifference = (1 - currentPrice / buyTriggerPrice) * -100;
  const buyLimitPrice = currentPrice * buyLimitPercentage;

  let buyATHRestrictionPrice = null;
  if (buyATHRestrictionEnabled) {
    buyATHRestrictionPrice = athPrice * buyATHRestrictionPercentage;
  }

  // Get last buy price
  const lastBuyPriceDoc = await getLastBuyPrice(logger, symbol);
  const lastBuyPrice = _.get(lastBuyPriceDoc, 'lastBuyPrice', null);

  const sellTriggerPrice =
    lastBuyPrice > 0 ? lastBuyPrice * sellTriggerPercentage : null;
  const sellDifference =
    lastBuyPrice > 0 ? (1 - sellTriggerPrice / currentPrice) * 100 : null;
  const sellLimitPrice = currentPrice * sellLimitPercentage;

  // Get stop loss trigger price
  const sellStopLossTriggerPrice =
    lastBuyPrice > 0 ? lastBuyPrice * sellMaxLossPercentage : null;
  const sellStopLossDifference =
    lastBuyPrice > 0
      ? (1 - sellStopLossTriggerPrice / currentPrice) * 100
      : null;

  // Estimate value
  const baseAssetEstimatedValue = baseAssetTotalBalance * currentPrice;
  const isLessThanMinNotionalValue =
    baseAssetEstimatedValue < parseFloat(minNotional);

  const sellCurrentProfit =
    lastBuyPrice > 0
      ? (currentPrice - lastBuyPrice) * baseAssetTotalBalance
      : null;

  const sellCurrentProfitPercentage =
    lastBuyPrice > 0 ? (1 - lastBuyPrice / currentPrice) * 100 : null;

  // Reorganise open orders
  const newOpenOrders = openOrders.map(order => {
    const newOrder = order;
    newOrder.currentPrice = currentPrice;
    newOrder.updatedAt = moment(order.time).utc();

    if (order.type !== 'STOP_LOSS_LIMIT') {
      return newOrder;
    }

    if (order.side.toLowerCase() === 'buy') {
      newOrder.limitPrice = buyLimitPrice;
      newOrder.limitPercentage = buyLimitPercentage;
      newOrder.differenceToExecute =
        (1 - parseFloat(order.stopPrice / currentPrice)) * 100;

      newOrder.differenceToCancel =
        (1 - parseFloat(order.stopPrice / buyLimitPrice)) * 100;
    }

    if (order.side.toLowerCase() === 'sell') {
      newOrder.limitPrice = sellLimitPrice;
      newOrder.limitPercentage = sellLimitPercentage;
      newOrder.differenceToExecute =
        (1 - parseFloat(order.stopPrice / currentPrice)) * 100;
      newOrder.differenceToCancel =
        (1 - parseFloat(order.stopPrice / sellLimitPrice)) * 100;

      newOrder.minimumProfit = null;
      newOrder.minimumProfitPercentage = null;
      if (lastBuyPrice > 0) {
        newOrder.minimumProfit =
          (parseFloat(order.price) - lastBuyPrice) * parseFloat(order.origQty);
        newOrder.minimumProfitPercentage =
          (1 - lastBuyPrice / parseFloat(order.price)) * 100;
      }
    }
    return newOrder;
  });

  // Populate data
  data.baseAssetBalance.estimatedValue = baseAssetEstimatedValue;
  data.baseAssetBalance.isLessThanMinNotionalValue = isLessThanMinNotionalValue;

  data.buy = {
    currentPrice,
    limitPrice: buyLimitPrice,
    highestPrice,
    lowestPrice,
    athPrice,
    athRestrictionPrice: buyATHRestrictionPrice,
    triggerPrice: buyTriggerPrice,
    difference: buyDifference,
    openOrders: newOpenOrders?.filter(o => o.side.toLowerCase() === 'buy'),
    processMessage: _.get(data, 'buy.processMessage', ''),
    updatedAt: moment().utc()
  };

  data.sell = {
    currentPrice,
    limitPrice: sellLimitPrice,
    lastBuyPrice,
    triggerPrice: sellTriggerPrice,
    difference: sellDifference,
    stopLossTriggerPrice: sellStopLossTriggerPrice,
    stopLossDifference: sellStopLossDifference,
    currentProfit: sellCurrentProfit,
    currentProfitPercentage: sellCurrentProfitPercentage,
    openOrders: newOpenOrders?.filter(o => o.side.toLowerCase() === 'sell'),
    processMessage: _.get(data, 'sell.processMessage', ''),
    updatedAt: moment().utc()
  };

  return data;
};

module.exports = { execute };
