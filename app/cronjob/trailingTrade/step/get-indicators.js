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
        currentGridTradeIndex: currentBuyGridTradeIndex,
        currentGridTrade: currentBuyGridTrade,
        athRestriction: {
          enabled: buyATHRestrictionEnabled,
          restrictionPercentage: buyATHRestrictionPercentage
        }
      },
      sell: {
        currentGridTrade: currentSellGridTrade,
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

  const cachedTradingView =
    JSON.parse(await cache.hget('trailing-trade-tradingview', `${symbol}`)) ||
    {};

  // Set trading view
  data.tradingView = cachedTradingView;

  // Set last candle
  data.lastCandle = cachedLatestCandle;
  // Merge indicator data
  data.indicators = {
    ...data.indicators,
    ...cachedIndicator
  };

  const { highestPrice, lowestPrice, athPrice } = data.indicators;

  // Get current price
  const currentPrice = parseFloat(cachedLatestCandle.close);

  // Get last buy price
  const lastBuyPriceDoc = await getLastBuyPrice(logger, symbol);
  const lastBuyPrice = _.get(lastBuyPriceDoc, 'lastBuyPrice', null);

  // #### Buy related variables
  // Set trigger price to be null which will prevent to buy.
  let buyTriggerPrice = null;
  let buyDifference = null;
  let buyLimitPrice = null;
  if (currentBuyGridTrade !== null) {
    const {
      triggerPercentage: buyTriggerPercentage,
      limitPercentage: buyLimitPercentage
    } = currentBuyGridTrade;

    // If grid trade index is 0 or last buy price is null, then use lowest price as trigger price.
    // If grid trade index is not 0 and last buy price is not null, then use last buy price
    const triggerPrice =
      currentBuyGridTradeIndex !== 0 && lastBuyPrice !== null
        ? lastBuyPrice
        : lowestPrice;

    buyTriggerPrice = triggerPrice * buyTriggerPercentage;
    buyDifference = (1 - currentPrice / buyTriggerPrice) * -100;
    buyLimitPrice = currentPrice * buyLimitPercentage;
  }

  let buyATHRestrictionPrice = null;
  if (buyATHRestrictionEnabled) {
    buyATHRestrictionPrice = athPrice * buyATHRestrictionPercentage;
  }
  // ##############################

  // #### Sell related variables
  // Set trigger price to be null which will prevent to sell.
  let sellTriggerPrice = null;
  let sellDifference = null;
  let sellLimitPrice = null;

  if (lastBuyPrice > 0 && currentSellGridTrade !== null) {
    const {
      triggerPercentage: sellTriggerPercentage,
      limitPercentage: sellLimitPercentage
    } = currentSellGridTrade;

    sellTriggerPrice = lastBuyPrice * sellTriggerPercentage;
    sellDifference = (1 - sellTriggerPrice / currentPrice) * 100;
    sellLimitPrice = currentPrice * sellLimitPercentage;
  }
  // ##############################

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
    lastBuyPrice > 0 ? (currentPrice / lastBuyPrice - 1) * 100 : null;

  // Reorganise open orders
  const newOpenOrders = openOrders.map(order => {
    const newOrder = order;
    newOrder.currentPrice = currentPrice;
    newOrder.updatedAt = moment(order.time).utc();

    if (order.type !== 'STOP_LOSS_LIMIT') {
      return newOrder;
    }

    if (order.side.toLowerCase() === 'buy') {
      newOrder.differenceToExecute =
        (1 - parseFloat(order.stopPrice / currentPrice)) * 100;

      newOrder.differenceToCancel =
        buyLimitPrice > 0
          ? (1 - parseFloat(order.stopPrice / buyLimitPrice)) * 100
          : null;
    }

    if (order.side.toLowerCase() === 'sell') {
      newOrder.differenceToExecute =
        (1 - parseFloat(order.stopPrice / currentPrice)) * 100;
      newOrder.differenceToCancel =
        sellLimitPrice > 0
          ? (1 - parseFloat(order.stopPrice / sellLimitPrice)) * 100
          : null;

      newOrder.minimumProfit = null;
      newOrder.minimumProfitPercentage = null;
      if (lastBuyPrice > 0) {
        newOrder.minimumProfit =
          (parseFloat(order.price) - lastBuyPrice) * parseFloat(order.origQty);
        newOrder.minimumProfitPercentage =
          (parseFloat(order.price) / lastBuyPrice - 1) * 100;
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
