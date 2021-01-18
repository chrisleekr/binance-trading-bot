/* eslint-disable no-nested-ternary */
/* eslint-disable prefer-destructuring */
const _ = require('lodash');
const config = require('config');
const { binance, slack, cache } = require('../../helpers');
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
 * Get candles from Binance and determine buy signal with lowest price
 *
 * @param {*} logger
 */
const getIndicators = async (symbol, logger) => {
  const simpleStopChaser = config.get('jobs.simpleStopChaser');

  logger.info({ simpleStopChaser }, 'Retrieved simpleStopChaser configuration');

  const candles = await binance.client.candles({
    symbol,
    interval: simpleStopChaser.candles.interval,
    limit: simpleStopChaser.candles.limit
  });

  const [lastCandle] = candles.slice(-1);

  logger.info({ lastCandle }, 'Retrieved candles');

  const candlesData = flattenCandlesData(candles);

  // MIN
  const lowestClosed = _.min(candlesData.close);
  logger.info({ lowestClosed }, 'Retrieved lowest closed value result');

  return {
    symbol,
    lowestClosed,
    lastCandle
  };
};

/**
 * Determine action based on indicator
 *
 * @param {*} logger
 * @param {*} indicators
 */
const determineAction = async (logger, indicators) => {
  let action = 'hold';

  const { symbol, lowestClosed, lastCandle } = indicators;

  if (lastCandle.close <= lowestClosed) {
    action = 'buy';
    logger.info(
      { symbol, lowestClosed, close: lastCandle.close },
      "Last closed value is less than lowest minimum price. Let's buy."
    );
  } else {
    logger.info(
      { symbol, lowestClosed, close: lastCandle.close },
      'Last closed value is higher than lowest minimum price. Do not buy.'
    );
  }

  return {
    symbol,
    action,
    lastCandleClose: lastCandle.close,
    lowestClosed
  };
};

/**
 * Place buy order based on buy signal
 *
 * @param {*} logger
 * @param {*} side
 * @param {*} percentage
 * @param {*} indicators
 */
const placeOrder = async (logger, side, percentage, indicators) => {
  logger.info({ side, percentage }, 'Start placing order');

  const { symbol } = indicators;

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
    symbol,
    side,
    type: 'LIMIT',
    quantity: orderQuantityInfo.orderQuantity,
    price: orderPriceInfo.orderPrice,
    timeInForce: 'GTC'
  };

  slack.sendMessage(`${symbol} Action: *${side}*
  - Free Balance: ${orderQuantityInfo.freeBalance}
  - Order Quantity: ${orderQuantityInfo.orderQuantity}
  - Order Params: \`\`\`${JSON.stringify(orderParams, undefined, 2)}\`\`\`
  `);

  logger.info({ orderParams }, 'Order params');
  const orderResult = await binance.client.order(orderParams);

  logger.info({ orderResult }, 'Order result');

  await cache.set(`last-buy-price-${symbol}`, orderPriceInfo.orderPrice);

  await slack.sendMessage(
    `${symbol} Action Result: *${side}*
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
  const { symbol } = indicators;
  const stopLossLimitInfo = config.get('jobs.simpleStopChaser.stopLossLimit');

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

    // 2-3. Get last buy price and make sure it is within minimum profit range.
    //  If not cached for some reason, it will just place stop-loss-limit order.
    const lastBuyPrice = +(await cache.get(`last-buy-price-${symbol}`)) || 0;
    logger.info({ lastBuyPrice }, 'Retrieved last buy price');

    const lastCandleClose = +indicators.lastCandle.close;
    logger.info({ lastCandleClose }, 'Retrieved last closed price');

    const calculatedLastBuyPrice = lastBuyPrice * +stopLossLimitInfo.lastBuyPercentage;

    if (lastCandleClose < calculatedLastBuyPrice) {
      logger.error(
        {
          lastCandleClose,
          lastBuyPrice,
          calculatedLastBuyPrice
        },
        `Last buy price is lower than current price. Do not place order.`
      );
      return {
        result: false,
        message: `Last buy price is lower than current price. Do not place order.`,
        lastCandleClose,
        lastBuyPrice,
        calculatedLastBuyPrice
      };
    }

    logger.info(
      { lastCandleClose, lastBuyPrice, calculatedLastBuyPrice },
      `Last buy price is higher than current price. Place order.`
    );

    //  2-4. Place stop loss order
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

    // 2-5. Wait for my money
    return stopLossLimitOrderInfo;
  }

  const order = openOrders[0];
  const basePrice = +indicators.lastCandle.close;
  // 3. If the order is not stop loss limit order, then do nothing
  if (order.type !== 'STOP_LOSS_LIMIT') {
    logger.info({ order }, 'Order is not STOP_LOSS_LIMIT, Do nothing.');
    return {
      result: false,
      message: 'Order is not STOP_LOSS_LIMIT, Do nothing.'
    };
  }

  // 4. If order's stop price is less than current price * limit percentage
  //      It means the price is increase more than expected, so cancel it and let's get more money.
  //      Don't worry about the cancel. It will place another STOP-LOSS-LIMIT order.
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
