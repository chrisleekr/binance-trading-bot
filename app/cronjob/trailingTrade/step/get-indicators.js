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
      filterPrice: { tickSize },
      filterMinNotional: { minNotional }
    },
    symbolConfiguration: {
      buy: {
        triggerPercentage: buyTriggerPercentage,
        limitPercentage: buyLimitPercentage
      },
      sell: {
        triggerPercentage: sellTriggerPercentage,
        hardPercentage: sellHardTriggerPercentage,
        limitPercentage: sellLimitPercentage,
        stopLoss: { maxLossPercentage: sellMaxLossPercentage }
      },
      botOptions: { calcFees },
      strategyOptions: {
        tradeOptions: { manyBuys },
        athRestriction: {
          enabled: buyATHRestrictionEnabled,
          restrictionPercentage: buyATHRestrictionPercentage
        }
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
  const { highestPrice, lowestPrice, athPrice, trend, prediction } =
    data.indicators;
  const currentPrice = parseFloat(cachedLatestCandle.close);
  const buyTriggerPrice = lowestPrice * buyTriggerPercentage;
  const buyDifference = (1 - currentPrice / buyTriggerPrice) * -100;
  const buyLimitPrice = currentPrice * buyLimitPercentage;

  const precision = parseFloat(tickSize) === 1 ? 0 : tickSize.indexOf(1) - 1;

  for (let i = 0; i < prediction.predictedValues.length; i += 1) {
    prediction.predictedValues[i] =
      prediction.predictedValues[i].toFixed(precision);
    prediction.realCandles[i] = prediction.realCandles[i].toFixed(precision);
  }

  // ATH calc
  let buyATHRestrictionPrice = null;
  if (buyATHRestrictionEnabled) {
    buyATHRestrictionPrice = athPrice * buyATHRestrictionPercentage;
  }

  // Get last buy price
  const lastBuyPriceDoc = await getLastBuyPrice(logger, symbol);
  const lastQuantityBought = _.get(lastBuyPriceDoc, 'quantity', null);
  const lastBuyPrice = _.get(lastBuyPriceDoc, 'lastBuyPrice', null);
  const lastBoughtPrice = _.get(lastBuyPriceDoc, 'lastBoughtPrice', null);

  let feeMultiplier = {
    roundUp: 1,
    roundDown: 1
  };

  if (calcFees) {
    feeMultiplier = {
      roundUp: 1.002,
      roundDown: 0.998
    };
  }

  const sellTriggerPrice =
    lastBuyPrice > 0
      ? lastBuyPrice * sellTriggerPercentage * feeMultiplier.roundUp
      : null;
  const sellHardTriggerPrice =
    lastBuyPrice > 0
      ? lastBuyPrice * sellHardTriggerPercentage * feeMultiplier.roundUp
      : null;
  const sellDifference =
    lastBuyPrice > 0 ? (1 - sellTriggerPrice / currentPrice) * 100 : null;
  const sellLimitPrice = currentPrice * sellLimitPercentage;

  // Get stop loss trigger price
  const sellStopLossTriggerPrice =
    lastBuyPrice > 0
      ? lastBuyPrice * sellMaxLossPercentage * feeMultiplier.roundUp
      : null;
  const sellStopLossDifference =
    lastBuyPrice > 0
      ? (1 -
          (sellStopLossTriggerPrice / currentPrice) * feeMultiplier.roundDown) *
        100
      : null;

  // Estimate value
  const baseAssetEstimatedValue = lastQuantityBought * currentPrice;
  const isLessThanMinNotionalValue =
    baseAssetEstimatedValue < parseFloat(minNotional);

  const sellCurrentProfit =
    lastBuyPrice > 0
      ? (currentPrice - lastBuyPrice) *
        feeMultiplier.roundUp *
        baseAssetTotalBalance
      : null;

  const sellCurrentProfitPercentage =
    lastBuyPrice > 0
      ? (1 - (lastBuyPrice / currentPrice) * feeMultiplier.roundUp) * 100
      : null;

  // Reorganize open orders
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
    trend,
    prediction,
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
    gridStrategyActivated: manyBuys,
    lastBuyPrice,
    lastQtyBought: lastQuantityBought,
    lastBoughtPrice,
    triggerPrice: sellTriggerPrice,
    hardTriggerPrice: sellHardTriggerPrice,
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
