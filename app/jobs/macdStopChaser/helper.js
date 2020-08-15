/* eslint-disable no-nested-ternary */
/* eslint-disable prefer-destructuring */
const _ = require('lodash');
const config = require('config');
const { binance, tulind, slack, cache } = require('../../helpers');
const commonHelper = require('../common/helper');

/**
 * Flatten candle data
 *
 * @param {*} candles
 */
const flattenCandlesData = candles => {
  const openTime = [];
  const close = [];

  candles.forEach(candle => {
    openTime.push(+candle.openTime);
    close.push(+candle.close);
  });

  return {
    openTime,
    close
  };
};

/**
 * Get candles from Binance and generate indicators using tulind
 *
 * @param {*} logger
 */
const getIndicators = async logger => {
  const candles = await binance.client.candles({
    symbol: config.get('jobs.macdStopChaser.symbol'),
    interval: config.get('jobs.macdStopChaser.candles.interval'),
    limit: config.get('jobs.macdStopChaser.candles.limit')
  });
  const [lastCandle] = candles.slice(-1);

  logger.info({ lastCandle }, 'Retrieved candles');

  const candlesData = flattenCandlesData(candles);

  // MACD
  const macdHistory = await tulind.macd(
    candlesData,
    config.get('jobs.macdStopChaser.macd.shortPeriod'),
    config.get('jobs.macdStopChaser.macd.longPeriod'),
    config.get('jobs.macdStopChaser.macd.signalPeriod')
  );

  logger.info({}, 'Retrieved MACD result');

  // MIN
  const min = _.min(candlesData.close.slice(config.get('jobs.macdStopChaser.min.period') * -1));
  const minHistory = { min, range: { min: min * 0.999, max: min * 1.001 } };
  logger.info({ minHistory }, 'Retrieved MIN result');

  return {
    macdHistory,
    minHistory,
    lastCandle
  };
};

/**
 * Determine action based on indicator
 *
 * @param {*} logger
 * @param {*} indicators
 */
const determineAction = (logger, indicators) => {
  let action = 'hold';

  const { macdHistory, minHistory, lastCandle } = indicators;

  // Checking trend
  const lastTrend = cache.get('last-macd-trend') || 'unknown';
  logger.info({ lastTrend }, 'Retrieved last trend');

  // Get current MACD result
  const macdResult = {};

  let allRising = true;
  let allFalling = true;
  for (let i = -3; i < 0; i += 1) {
    let macdValue = 0;
    let macdSignal = 0;
    if (i !== -1) {
      macdValue = macdHistory[0].slice(i, i + 1)[0];
      macdSignal = macdHistory[1].slice(i, i + 1)[0];
    } else {
      macdValue = macdHistory[0].slice(i)[0];
      macdSignal = macdHistory[1].slice(i)[0];
    }
    const trend = macdValue > macdSignal ? 'rising' : 'falling';
    if (trend === 'falling') {
      allRising = false;
    }
    if (trend === 'rising') {
      allFalling = false;
    }
    macdResult[`last${i}`] = {
      macdValue,
      macdSignal,
      trend
    };
  }

  logger.info({ macdResult }, 'Retrieved last/current MACD result');

  const currentTrend = allRising ? 'rising' : allFalling ? 'falling' : 'wait';

  logger.info({ currentTrend }, 'Current trend');

  if (lastTrend !== 'unknown') {
    if (lastTrend === 'falling' && currentTrend === 'rising') {
      action = 'buy';
    }
    if (lastTrend === 'rising' && currentTrend === 'falling') {
      action = 'sell';
    }
  }
  logger.info({ lastTrend, currentTrend, action }, 'Determined action.');

  if (action === 'buy') {
    if (lastCandle.close > minHistory.range.max) {
      logger.info(
        { min: minHistory.range.min, close: lastCandle.close, max: minHistory.range.max },
        'Last closed value is higher than minimum range.'
      );
      return { currentTrend: 'wait', action: 'hold' };
    }
    logger.info(
      { min: minHistory.range.min, close: lastCandle.close, max: minHistory.range.max },
      'Last closed value is within minimum range.'
    );
  }

  // Save only if rising or falling
  if (currentTrend === 'rising' || currentTrend === 'falling') {
    cache.set('last-macd-trend', currentTrend);
  }

  return { currentTrend, action };
};

/**
 * Place buy order based on MACD buy singal
 *
 * @param {*} logger
 * @param {*} side
 * @param {*} percentage
 * @param {*} indicators
 */
const placeOrder = async (logger, side, percentage, indicators) => {
  logger.info({ side, percentage }, 'Start placing order');

  const symbol = config.get('jobs.macdStopChaser.symbol');

  // 1. Cancel all orders
  await commonHelper.cancelOpenOrders(logger, binance, symbol);

  // 1. Get symbol info
  const symbolInfo = await commonHelper.getSymbolInfo(logger, binance, symbol);

  // 2. Get balance for trade asset
  const balanceInfo = await commonHelper.getBalance(logger, binance, symbolInfo, side);
  if (balanceInfo.result === false) {
    return balanceInfo;
  }

  logger.info({ balanceInfo }, 'Balance result');

  // 3. Get order quantity
  const orderQuantityInfo = commonHelper.getOrderQuantity(
    logger,
    symbolInfo,
    side,
    balanceInfo,
    percentage,
    indicators
  );
  if (orderQuantityInfo.result === false) {
    return orderQuantityInfo;
  }

  // 4. Get order price
  const orderPriceInfo = commonHelper.getOrderPrice(logger, symbolInfo, orderQuantityInfo);
  if (orderPriceInfo.result === false) {
    return orderPriceInfo;
  }

  // 5. Place order
  const orderParams = {
    symbol: config.get('jobs.macdStopChaser.symbol'),
    side,
    type: 'LIMIT',
    quantity: orderQuantityInfo.orderQuantity,
    price: orderPriceInfo.orderPrice,
    timeInForce: 'GTC'
  };

  slack.sendMessage(`Action: *${side}*
  - Free Balance: ${orderQuantityInfo.freeBalance}
  - Order Quantity: ${orderQuantityInfo.orderQuantity}
  - Order Params: \`\`\`${JSON.stringify(orderParams, undefined, 2)}\`\`\`
  `);

  logger.info({ orderParams }, 'Order params');
  const orderResult = await binance.client.order(orderParams);

  logger.info({ orderResult }, 'Order result');

  await slack.sendMessage(
    `Action Result: *${side}*
    - Order Result: \`\`\`${JSON.stringify(orderResult, undefined, 2)}\`\`\``
  );

  return orderResult;
};

/**
 * Chase stop loss order
 *  Keep chasing dream
 *
 * @param {*} logger
 * @param {*} indicators
 */
const chaseStopLossLimitOrder = async (logger, indicators) => {
  logger.info('Start chaseStopLossLimitOrder');
  const symbol = config.get('jobs.macdStopChaser.symbol');
  const stopLossLimitInfo = config.get('jobs.macdStopChaser.stopLossLimit');

  // 1. Get open orders
  const openOrders = await commonHelper.getOpenOrders(logger, binance, symbol);

  // 2. If there is no open orders
  if (openOrders.length === 0) {
    // 2-1. Get symbol info
    const symbolInfo = await commonHelper.getSymbolInfo(logger, binance, symbol);

    //  2-2. Get current balance BTC. If no current balance, then return.
    const balanceInfo = await commonHelper.getBalance(logger, binance, symbolInfo, 'sell');
    if (balanceInfo.result === false) {
      return balanceInfo;
    }

    //  2-1. Place stop loss order
    const stopLossLimitOrderInfo = await commonHelper.placeStopLossLimitOrder(
      logger,
      binance,
      slack,
      symbolInfo,
      balanceInfo,
      indicators,
      stopLossLimitInfo
    );
    logger.info({ stopLossLimitOrderInfo }, 'StopLossLimitOrderInfo Result');

    //  2-2. Return

    return stopLossLimitOrderInfo;
  }

  const order = openOrders[0];
  const basePrice = +indicators.lastCandle.close;
  // 3. If the order is not stop loss limit order, then do nothing
  if (order.type !== 'STOP_LOSS_LIMIT') {
    logger.info({ order }, 'Order is not STOP_LOSS_LIMIT, do nothing.');
    return {
      result: false,
      message: 'Order is not STOP_LOSS_LIMIT, do nothing.'
    };
  }

  // 4. If order's stop price is less than current price * 0.99
  if (order.stopPrice < basePrice * stopLossLimitInfo.limitPercentage) {
    //  4-1. Cancel order
    logger.info(
      { stopPrice: order.stopPrice, basePrice, limitPercentage: basePrice * stopLossLimitInfo.limitPercentage },
      'Stop price is outside of expected range.'
    );
    await commonHelper.cancelOpenOrders(logger, binance, symbol);
  } else {
    logger.info(
      { stopPrice: order.stopPrice, basePrice, limitPercentage: basePrice * stopLossLimitInfo.limitPercentage },
      'Stop price is within range.'
    );
  }

  logger.info('Finished chaseStopLossLimitOrder');
  return {
    result: true,
    message: 'Finished to handle chaseStopLossLimitOrder'
  };
};

module.exports = {
  flattenCandlesData,
  getIndicators,
  determineAction,
  placeOrder,
  chaseStopLossLimitOrder
};
