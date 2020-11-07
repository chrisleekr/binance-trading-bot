const moment = require('moment');
const config = require('config');
const { binance, tulind, slack } = require('../../helpers');
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
    symbol: config.get('jobs.bbands.symbol'),
    interval: config.get('jobs.bbands.candles.interval'),
    limit: config.get('jobs.bbands.candles.limit')
  });

  const [lastCandle] = candles.slice(-1);

  logger.info('Retrieved candles');

  const candlesData = flattenCandlesData(candles);

  const [lastOpenTime] = candlesData.openTime.slice(-1);

  // Bollinger Bands
  const bbandsResult = await tulind.bbands(
    candlesData,
    config.get('jobs.bbands.period'),
    config.get('jobs.bbands.stddev')
  );

  const [bbandsLower] = bbandsResult[0].slice(-1);
  const [bbandsMiddle] = bbandsResult[1].slice(-1);
  const [bbandsUpper] = bbandsResult[2].slice(-1);

  return {
    bbands: {
      openTime: moment(lastOpenTime).format('YYYY-MM-DD HH:mm:ss'),
      lower: bbandsLower,
      middle: bbandsMiddle,
      upper: bbandsUpper
    },
    lastCandle
  };
};

/**
 * Determine action based on indicator
 *
 * @param {*} indicators
 */
const determineAction = (logger, indicators) => {
  let action = 'hold';

  // If last candle's closed price is less than lower than Bollinger Bands lower point, then action is to buy
  if (indicators.lastCandle.close < indicators.bbands.lower) {
    logger.info("Closed price is less than bbands lower price. Let's buy.");
    action = 'buy';
  }

  // If last candle's closed price is more than Bollinger Bands upper point, then action is to sell
  if (indicators.lastCandle.close > indicators.bbands.upper) {
    logger.info("Closed price is more than bbands upper price. Let's sell.");
    action = 'sell';
  }

  // Otherwise, let's hold
  return action;
};

/**
 * Place order to Binance
 *
 * @param {*} logger
 * @param {*} tradeAction
 * @param {*} percentage
 * @param {*} indicators
 */
const placeOrder = async (logger, tradeAction, percentage, indicators) => {
  const symbol = config.get('jobs.bbands.symbol');
  // 1. Cancel any open orders
  await commonHelper.cancelOpenOrders(logger, binance, symbol);

  // 2. Get symbol info
  const symbolInfo = await commonHelper.getSymbolInfo(logger, binance, symbol);

  // 3. Get balance for trade asset
  const balanceInfo = await commonHelper.getBalance(logger, binance, symbolInfo, tradeAction);
  if (balanceInfo.result === false) {
    return balanceInfo;
  }

  // 4. Get order quantity
  const orderQuantityInfo = commonHelper.getOrderQuantity(
    logger,
    symbolInfo,
    tradeAction,
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
    side: tradeAction,
    type: 'LIMIT',
    quantity: orderQuantityInfo.orderQuantity,
    price: orderPriceInfo.orderPrice,
    timeInForce: 'GTC'
  };

  slack.sendMessage(`Action: *${tradeAction}*
  - Free Balance: ${orderQuantityInfo.freeBalance}
  - Order Quantity: ${orderQuantityInfo.orderQuantity}
  - Indicator:\`\`\`${JSON.stringify(indicators, undefined, 2)}\`\`\`
  - Order Params: \`\`\`${JSON.stringify(orderParams, undefined, 2)}\`\`\`
  `);

  logger.info({ orderParams }, 'Order params');

  const orderResult = await binance.client.order(orderParams);

  logger.info({ orderResult }, 'Order result');

  await slack.sendMessage(
    `Action Result: *${tradeAction}*
    - Order Result: \`\`\`${JSON.stringify(orderResult, undefined, 2)}\`\`\``
  );

  return orderResult;
};

module.exports = { getIndicators, flattenCandlesData, determineAction, placeOrder };
