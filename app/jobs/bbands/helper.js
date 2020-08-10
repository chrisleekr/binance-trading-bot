const _ = require('lodash');
const moment = require('moment');
const config = require('config');
const { binance, tulind, slack } = require('../../helpers');

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

  // If close is less than lower, buy
  if (indicators.lastCandle.close < indicators.bbands.lower) {
    logger.info("Closed price is less than bbands lower price. Let's buy.");
    action = 'buy';
  }

  // If close is more than upper, sell
  if (indicators.lastCandle.close > indicators.bbands.upper) {
    logger.info("Closed price is more than bbands upper price. Let's sell.");
    action = 'sell';
  }

  // Otherwise, hold

  return action;
};

/**
 * Cancel any open orders to get available balance
 *
 * @param {*} logger
 * @param {*} symbol
 */
const cancelOpenOrders = async (logger, symbol) => {
  logger.info('Cancelling open orders');
  // Cancel open orders first to make sure it does not have unsettled orders.
  try {
    const result = await binance.client.cancelOpenOrders({ symbol });
    logger.info({ result }, 'Cancelled open orders');
  } catch (e) {
    logger.info({ e }, 'Cancel result failed, but it is ok. Do not worry');
  }
};

/**
 * Retrieve balance for trade asset based on the side
 *
 * @param {*} logger
 * @param {*} symbolInfo
 * @param {*} side
 */
const getBalance = async (logger, symbolInfo, side) => {
  // 1. Get account info
  const accountInfo = await binance.client.accountInfo();
  logger.info('Retrieved Account info');

  const tradeAsset = side === 'buy' ? symbolInfo.quoteAsset : symbolInfo.baseAsset;
  logger.info({ tradeAsset }, 'Determined trade asset');

  // 2. Get trade asset balance
  const balance =
    _.filter(accountInfo.balances, b => {
      return b.asset === tradeAsset;
    })[0] || {};

  if (_.isEmpty(balance)) {
    logger.error({ symbolInfo, balance }, 'Balance cannot be found.');
    return {
      result: false,
      message: 'Balance cannot be found.',
      balance
    };
  }

  logger.info({ balance }, 'Balance found');

  // 3. Calculate free balance with precision
  const lotPrecision = symbolInfo.filterLotSize.stepSize.indexOf(1) - 1;
  const freeBalance = +(+balance.free).toFixed(lotPrecision);

  // 4. Validate free balance for buy action
  if (side === 'buy' && freeBalance < +symbolInfo.filterMinNotional.minNotional) {
    logger.error({ symbolInfo, freeBalance }, 'Balance is less than minimum notional.');

    return {
      result: false,
      message: 'Balance is less than minimum notional.',
      freeBalance
    };
  }

  return {
    result: true,
    message: 'Balance found',
    freeBalance
  };
};

/**
 * Calculate order quantity
 *
 * @param {*} logger
 * @param {*} symbolInfo
 * @param {*} side
 * @param {*} balanceInfo
 * @param {*} percentage
 * @param {*} indicators
 */
const getOrderQuantity = (logger, symbolInfo, side, balanceInfo, percentage, indicators) => {
  const baseAssetPrice = +indicators.lastCandle.close;
  logger.info({ baseAssetPrice }, 'Retrieved latest asset price');

  const lotPrecision = symbolInfo.filterLotSize.stepSize.indexOf(1) - 1;
  const { freeBalance } = balanceInfo;

  let orderQuantity = 0;

  if (side === 'buy') {
    const orderQuantityBeforeCommission = 1 / (+baseAssetPrice / freeBalance / (percentage / 100));
    orderQuantity = +(orderQuantityBeforeCommission - orderQuantityBeforeCommission * (0.1 / 100)).toFixed(
      lotPrecision
    );

    if (orderQuantity <= 0) {
      logger.error({ freeBalance, orderQuantity }, 'Order quantity is less or equal than 0.');
      return {
        result: false,
        message: 'Order quantity is less or equal than 0.',
        baseAssetPrice,
        orderQuantity,
        freeBalance
      };
    }
  }

  if (side === 'sell') {
    const orderQuantityBeforeCommission = freeBalance * (percentage / 100);
    orderQuantity = +(orderQuantityBeforeCommission - orderQuantityBeforeCommission * (0.1 / 100)).toFixed(
      lotPrecision
    );

    if (orderQuantity <= +symbolInfo.filterPrice.minPrice) {
      logger.error(
        { freeBalance, symbolInfo },
        `Order quantity is less or equal than minimum quantity - ${symbolInfo.filterPrice.minPrice}.`
      );
      return {
        result: false,
        message: `Order quantity is less or equal than minimum quantity - ${symbolInfo.filterPrice.minPrice}.`,
        baseAssetPrice,
        orderQuantity,
        freeBalance
      };
    }
  }
  logger.info({ orderQuantity }, 'Order quantity');

  return {
    result: true,
    message: `Calculated order quantity`,
    baseAssetPrice,
    orderQuantity,
    freeBalance
  };
};

/**
 * Calculate order price
 *
 * @param {*} logger
 * @param {*} symbolInfo
 * @param {*} orderQuantityInfo
 */
const getOrderPrice = (logger, symbolInfo, orderQuantityInfo) => {
  const orderPrecision = symbolInfo.filterPrice.tickSize.indexOf(1) - 1;
  const orderPrice = +(+orderQuantityInfo.baseAssetPrice).toFixed(orderPrecision);
  logger.info({ orderPrecision, orderPrice }, 'Calculated order price');

  return {
    result: true,
    orderPrice
  };
};

/**
 * Place order
 *
 * @param {*} logger
 * @param {*} side
 * @param {*} percentage
 * @param {*} indicators
 */
const placeOrder = async (logger, side, percentage, indicators) => {
  const symbol = config.get('jobs.bbands.symbol');
  // 1. Cancel any open orders
  await cancelOpenOrders(logger, symbol);

  // 2. Get symbol info
  const symbolInfo = await binance.getSymbolInfo(logger, symbol);

  // 3. Get balance for trade asset
  const balanceInfo = await getBalance(logger, symbolInfo, side);
  if (balanceInfo.result === false) {
    return balanceInfo;
  }

  // 4. Get order quantity
  const orderQuantityInfo = getOrderQuantity(logger, symbolInfo, side, balanceInfo, percentage, indicators);
  if (orderQuantityInfo.result === false) {
    return orderQuantityInfo;
  }

  // 4. Get order price
  const orderPriceInfo = getOrderPrice(logger, symbolInfo, orderQuantityInfo);
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

  slack.sendMessage(`Action: *${side}*
  - Free Balance: ${orderQuantityInfo.freeBalance}
  - Order Quantity: ${orderQuantityInfo.orderQuantity}
  - Indicator:\`\`\`${JSON.stringify(indicators, undefined, 2)}\`\`\`
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

module.exports = { getIndicators, flattenCandlesData, determineAction, placeOrder };
