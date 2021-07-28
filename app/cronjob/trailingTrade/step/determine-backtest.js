const moment = require('moment');
const _ = require('lodash');
const { messenger } = require('../../../helpers');
const { roundDown } = require('../../trailingTradeHelper/util');

/**
 * Check whether can buy or not
 *
 * @param {*} data
 * @returns
 */

const flattenCandlesData = candles => {
  const openTime = [];
  const high = [];
  const low = [];
  const close = [];

  candles.forEach(candle => {
    openTime.push(+candle.openTime);
    high.push(+candle.high);
    low.push(+candle.low);
    close.push(+candle.close);
  });

  return {
    openTime,
    high,
    low,
    close
  };
};

const huskyTrend = candles => {
  const candleLows = candles.close;

  let newCandle = 1;
  let diff = 0;
  let status = 'not enough data';
  const positiveMultiplier = 1;
  const negativeMultiplier = -1.015;

  candleLows.forEach(candle => {
    const newCandleToTest = candleLows[newCandle];
    if (newCandleToTest != undefined) {
      let calc = 0;
      if (candle <= newCandleToTest) {
        calc = (newCandleToTest - candle) * positiveMultiplier;
      } else {
        calc = (candle - newCandleToTest) * negativeMultiplier;
      }

      diff += calc;
    }
    newCandle++;
  });

  switch (Math.sign(diff)) {
    case -1:
      status = 'FALLING';
      break;
    case 0:
      status = 'TREND IS TURNING';
      break;
    case 1:
      status = 'UP';
      break;
  }

  const difference = diff.toFixed(6);

  return { status, difference };
};

const canBuy = (currentBuyTrigger, currentPrice, lastBuyPrice) =>
  lastBuyPrice <= 0 && currentPrice <= currentBuyTrigger;

/**
 * Check whether has enough balance to sell
 *
 * @param {*} data
 * @returns
 */
const hasBalanceToSell = (data, currentPrice, quantity) => {
  const {
    symbolInfo: {
      filterMinNotional: { minNotional }
    }
  } = data;

  return quantity * currentPrice >= parseFloat(minNotional);
};

/**
 * Check whether can sell or not
 *
 * @param {*} data
 * @returns
 */
const canSell = (data, currentPrice, lastBuyPrice, quantity) => {
  const {
    symbolInfo: {
      filterMinNotional: { minNotional }
    }
  } = data;

  return lastBuyPrice != 0 && quantity * currentPrice > parseFloat(minNotional);
};

/**
 * Check whether current price is higher than sell trigger price
 *
 * @param {*} data
 * @returns
 */
const isHigherThanSellTriggerPrice = (currentSellTrigger, currentPrice) =>
  currentPrice >= currentSellTrigger;

const isHigherThanHardSellTriggerPrice = (data, currentPrice) => {
  const {
    sell: { triggerPrice: sellTriggerPrice, hardSellTriggerPrice }
  } = data;

  return currentPrice >= sellTriggerPrice * 1.0045;
};

const isHigherThanSellTriggerPriceAndTrendIsDown = (
  currentSellTrigger,
  currentPrice
) => currentPrice >= currentSellTrigger;

/**
 * Check whether current price is lower or equal than stop loss trigger price
 *
 * @param {*} data
 * @returns
 */
const isLowerThanStopLossTriggerPrice = (data, currentPrice, lastBuyPrice) => {
  const {
    symbolConfiguration: {
      sell: {
        stopLoss: { enabled: sellStopLossEnabled, maxLossPercentage }
      }
    }
  } = data;

  const calculatedTriggerPrice = lastBuyPrice * maxLossPercentage;

  return sellStopLossEnabled === true && currentPrice <= calculatedTriggerPrice;
};

/**
 * Determine action for trade
 *
 * @param {*} logger
 * @param {*} rawData
 */
const executeBackTest = async (
  rawData,
  lastDaysCandles,
  backtestBalance,
  symbolInfo,
  configuration
) => {
  const data = rawData;
  const { symbol } = data;
  const {
    filterPrice: { tickSize },
    filterLotSize: { stepSize }
  } = symbolInfo;
  const {
    candles: { limit },
    buy: { maxPurchaseAmount, limitPercentage, triggerPercentage },
    sell: { triggerPercentage: sellTriggerPercentage }
  } = configuration;

  const lotPrecision = parseFloat(stepSize) === 1 ? 0 : stepSize.indexOf(1) - 1;
  const pricePrecision =
    parseFloat(tickSize) === 1 ? 0 : tickSize.indexOf(1) - 1;

  let i = 0;

  const finalBacktestBalance = backtestBalance;

  let lastCurrentPrice = 0;

  const backTestResult = {
    profit: 0,
    buys: 0,
    sells: 0,
    symbol,
    quantity: 0,
    lastBuyPrice: 0,
    remainingMoney: finalBacktestBalance
  };

  const candlesToTest = lastDaysCandles;

  await candlesToTest.forEach(candle => {
    if (i >= limit) {
      const trendCandles = [];
      let beforeDontCount = 0;
      lastDaysCandles.forEach(candleTrend => {
        if (beforeDontCount <= i && beforeDontCount <= limit) {
          trendCandles.push(candleTrend);
        }
        beforeDontCount++;
      });

      const flattenedCandles = flattenCandlesData(trendCandles);
      const finalTrendCandles = huskyTrend(flattenedCandles);

      const lowestPrice = _.min(flattenedCandles.low);

      const currentPrice = candle.open;

      let retrievedLastBuyPrice = 0;

      if (backTestResult.lastBuyPrice != 0) {
        retrievedLastBuyPrice = backTestResult.lastBuyPrice;
      }

      const currentSellTrigger = retrievedLastBuyPrice * sellTriggerPercentage;

      const currentBuyTrigger = lowestPrice * triggerPercentage;

      const limitPrice = roundDown(
        currentPrice * limitPercentage,
        pricePrecision
      );

      let freeBalance = parseFloat(
        _.floor(finalBacktestBalance, pricePrecision)
      );

      if (freeBalance > maxPurchaseAmount) {
        freeBalance = maxPurchaseAmount;
      }

      const orderQuantityBeforeCommission = 1 / (limitPrice / freeBalance);

      const orderQuantity = parseFloat(
        _.floor(
          orderQuantityBeforeCommission -
            orderQuantityBeforeCommission * (0.1 / 100),
          lotPrecision
        )
      );

      let hasBalanceToSellcalc = 0;
      if (backTestResult.quantity != 0) {
        hasBalanceToSellcalc = backTestResult.quantity;
      }

      // Check buy signal -
      //  if last buy price is less than 0
      //    and current price is less or equal than lowest price
      //    and current balance has not enough value to sell,
      //  then buy.

      if (canBuy(currentBuyTrigger, currentPrice, retrievedLastBuyPrice)) {
        if (!hasBalanceToSell(data, currentPrice, hasBalanceToSellcalc)) {
          const calcProfit = parseFloat(orderQuantity * currentPrice) * -1;

          backTestResult.profit += calcProfit;
          backTestResult.buys++;
          backTestResult.quantity = orderQuantity;
          backTestResult.lastBuyPrice = currentPrice;
          backTestResult.remainingMoney += calcProfit;
        }
      }

      // Check sell signal - if
      //  last buy price has a value
      //  and total balance is enough to sell
      if (
        canSell(data, currentPrice, retrievedLastBuyPrice, hasBalanceToSellcalc)
      ) {
        // And its above the HARD sell trigger.
        if (isHigherThanHardSellTriggerPrice(data, currentPrice)) {
          // Then sell market order
          const calcProfit = parseFloat(hasBalanceToSellcalc * currentPrice);

          backTestResult.profit += calcProfit;
          backTestResult.sells++;
          backTestResult.quantity = 0;
          backTestResult.lastBuyPrice = 0;
          backTestResult.remainingMoney += calcProfit;
        } else if (
          isHigherThanSellTriggerPrice(currentSellTrigger, currentPrice)
        ) {
          const calcProfit = parseFloat(hasBalanceToSellcalc * currentPrice);

          backTestResult.profit += calcProfit;
          backTestResult.sells++;
          backTestResult.quantity = 0;
          backTestResult.lastBuyPrice = 0;
          backTestResult.remainingMoney += calcProfit;
        } else if (
          isLowerThanStopLossTriggerPrice(
            data,
            currentPrice,
            retrievedLastBuyPrice
          )
        ) {
          // Then sell market order

          const calcProfit = parseFloat(hasBalanceToSellcalc * currentPrice);

          backTestResult.profit += calcProfit;
          backTestResult.sells++;
          backTestResult.quantity = 0;
          backTestResult.lastBuyPrice = 0;
          backTestResult.remainingMoney += calcProfit;
        }
      }
      lastCurrentPrice = currentPrice;
    }
    i++;
  });

  if (backTestResult.buys > backTestResult.sells) {
    backTestResult.profit += backTestResult.quantity * lastCurrentPrice;
    backTestResult.remainingBoughtAsset =
      backTestResult.quantity * lastCurrentPrice;
  }
  return backTestResult;
};

module.exports = { executeBackTest };
