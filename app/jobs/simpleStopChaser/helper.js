const moment = require('moment');
const _ = require('lodash');
const config = require('config');
const { binance, slack, cache, mongo } = require('../../helpers');

const getConfiguration = async logger => {
  const configValue = await mongo.findOne(logger, 'simple-stop-chaser-common', {
    key: 'configuration'
  });

  let simpleStopChaserConfig = {};
  if (_.isEmpty(configValue) === false) {
    logger.info('Found simple stop chaser config from MongoDB');
    simpleStopChaserConfig = configValue;
  } else {
    simpleStopChaserConfig = config.get('jobs.simpleStopChaser');
    await mongo.upsertOne(
      logger,
      'simple-stop-chaser-common',
      {
        key: 'configuration'
      },
      {
        key: 'configuration',
        ...simpleStopChaserConfig
      }
    );
    logger.info(
      'Could not find configuration from MongoDB, retrieve from cache'
    );
  }

  return simpleStopChaserConfig;
};

/**
 * Calculate round down
 *
 * @param {*} number
 * @param {*} decimals
 */
const roundDown = (number, decimals) => {
  // eslint-disable-next-line no-restricted-properties
  return Math.floor(number * Math.pow(10, decimals)) / Math.pow(10, decimals);
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
    logger.info({ e }, 'Cancel result failed, but it is ok. Do not worry.');
  }
};

/**
 * Get symbol information
 *
 * @param {*} logger
 * @param {*} symbol
 */
const getSymbolInfo = async (logger, symbol) => {
  const cachedSymbolInfo = await cache.hget(
    'simple-stop-chaser-symbols',
    `${symbol}-symbol-info`
  );
  if (cachedSymbolInfo) {
    logger.info({ cachedSymbolInfo }, 'Retrieved symbol info from the cache.');
    return JSON.parse(cachedSymbolInfo);
  }

  logger.info({}, 'Request exchange info from Binance.');

  const exchangeInfo = await binance.client.exchangeInfo();

  logger.info({}, 'Retrieved exchange info from Binance.');
  const symbolInfo =
    _.filter(exchangeInfo.symbols, s => {
      return s.symbol === symbol;
    })[0] || {};

  symbolInfo.filterLotSize =
    _.filter(symbolInfo.filters, f => f.filterType === 'LOT_SIZE')[0] || {};
  symbolInfo.filterPrice =
    _.filter(symbolInfo.filters, f => f.filterType === 'PRICE_FILTER')[0] || {};
  symbolInfo.filterPercent =
    _.filter(symbolInfo.filters, f => f.filterType === 'PERCENT_PRICE')[0] ||
    {};
  symbolInfo.filterMinNotional =
    _.filter(symbolInfo.filters, f => f.filterType === 'MIN_NOTIONAL')[0] || {};

  const success = await cache.hset(
    'simple-stop-chaser-symbols',
    `${symbol}-symbol-info`,
    JSON.stringify(symbolInfo)
  );
  logger.info({ success, symbolInfo }, 'Retrieved symbol info from Binance.');
  return symbolInfo;
};

/**
 * Retrieve balance for buy trade asset based on the trade action
 *
 * @param {*} logger
 * @param {*} indicators
 * @param {*} options
 */
const getBuyBalance = async (logger, indicators, options) => {
  const { symbolInfo, lastCandle } = indicators;
  logger.info({ lastCandle }, 'Retrieve last candle');

  // 1. Get account info
  const accountInfo = await binance.client.accountInfo({ recvWindow: 10000 });

  logger.info('Retrieved Account info');

  const { quoteAsset, baseAsset } = symbolInfo;
  logger.info({ quoteAsset, baseAsset }, 'Retrieve assets');

  // 2. Get quote asset balance
  const quoteAssetBalance =
    _.filter(accountInfo.balances, b => {
      return b.asset === quoteAsset;
    })[0] || {};

  const baseAssetBalance =
    _.filter(accountInfo.balances, b => {
      return b.asset === baseAsset;
    })[0] || {};

  if (_.isEmpty(quoteAssetBalance) || _.isEmpty(baseAssetBalance)) {
    return {
      result: false,
      message: 'Balance is not found. Cannot place an order.',
      quoteAssetBalance,
      baseAssetBalance
    };
  }

  const baseAssetTotalBalance =
    +baseAssetBalance.free + +baseAssetBalance.locked;

  logger.info({ quoteAssetBalance, baseAssetBalance }, 'Balance found');

  // 3. Make sure we don't have base asset balance which assume already purchased.
  const lastCandleClose = +lastCandle.close;
  if (
    baseAssetTotalBalance * lastCandleClose >
    +symbolInfo.filterMinNotional.minNotional
  ) {
    return {
      result: false,
      message:
        'The base asset has enough balance to place a stop-loss limit order. Cannot place a buy order.',
      baseAsset,
      baseAssetTotalBalance,
      lastCandleClose,
      currentBalanceInQuoteAsset: baseAssetTotalBalance * lastCandleClose,
      minNotional: symbolInfo.filterMinNotional.minNotional
    };
  }

  // 4. Calculate free balance with precision
  const lotPrecision = symbolInfo.filterLotSize.stepSize.indexOf(1) - 1;
  let freeBalance = parseFloat(_.floor(+quoteAssetBalance.free, lotPrecision));

  logger.info({ freeBalance }, 'Current free balance');

  // 5. Check if free balance is more than maximum purchase amount (USDT),
  if (freeBalance > options.maxPurchaseAmount) {
    freeBalance = options.maxPurchaseAmount;
    logger.info({ freeBalance }, 'Adjusted free balance');
  }

  // 6. Validate free balance for buy action
  if (freeBalance < +symbolInfo.filterMinNotional.minNotional) {
    return {
      result: false,
      message:
        'Balance is less than the minimum notional. Cannot place an order.',
      freeBalance
    };
  }

  return {
    result: true,
    message: 'Balance found.',
    freeBalance
  };
};

/**
 * Retrieve balance for buy trade asset based on the trade action
 *
 * @param {*} logger
 * @param {*} symbolInfo
 * @param {*} indicators
 * @param {*} stopLossLimitConfig
 */
const getSellBalance = async (
  logger,
  symbolInfo,
  indicators,
  stopLossLimitConfig
) => {
  // 1. Get account info
  const accountInfo = await binance.client.accountInfo({ recvWindow: 10000 });
  logger.info('Retrieved Account info');

  const { baseAsset, symbol } = symbolInfo;
  logger.info({ baseAsset }, 'Retrieved base asset');

  // 2. Get trade asset balance
  const baseAssetBalance =
    _.filter(accountInfo.balances, b => {
      return b.asset === baseAsset;
    })[0] || {};

  if (_.isEmpty(baseAssetBalance)) {
    return {
      result: false,
      message: 'Balance is not found. Cannot place an order.',
      baseAssetBalance
    };
  }

  logger.info({ baseAssetBalance }, 'Balance found');

  // 3. Calculate free balance with precision
  const lotPrecision = symbolInfo.filterLotSize.stepSize.indexOf(1) - 1;
  const freeBalance = parseFloat(_.floor(+baseAssetBalance.free, lotPrecision));
  const lockedBalance = parseFloat(
    _.floor(+baseAssetBalance.locked, lotPrecision)
  );

  // 4. If total balance is not enough to sell, then the last buy price is meaningless.
  const totalBalance = freeBalance + lockedBalance;

  // Calculate quantity - commission
  const quantity = parseFloat(
    _.floor(totalBalance - totalBalance * (0.1 / 100), lotPrecision)
  );

  if (quantity <= +symbolInfo.filterLotSize.minQty) {
    await mongo.deleteOne(logger, 'simple-stop-chaser-symbols', {
      key: `${symbol}-last-buy-price`
    });
    return {
      result: false,
      message: 'Balance found, but not enough to sell. Delete last buy price.',
      freeBalance,
      lockedBalance
    };
  }

  const lastCandleClose = +indicators.lastCandle.close;
  const orderPrecision = symbolInfo.filterPrice.tickSize.indexOf(1) - 1;
  const price = roundDown(
    lastCandleClose * +stopLossLimitConfig.limitPercentage,
    orderPrecision
  );

  // Notional value = contract size (order quantity) * underlying price (order price)
  if (quantity * price < +symbolInfo.filterMinNotional.minNotional) {
    await mongo.deleteOne(logger, 'simple-stop-chaser-symbols', {
      key: `${symbol}-last-buy-price`
    });
    return {
      result: false,
      message:
        'Balance found, but the notional value is less than the minimum notional value. Delete last buy price.',
      freeBalance,
      lockedBalance
    };
  }

  return {
    result: true,
    message: 'Balance found.',
    freeBalance,
    lockedBalance
  };
};

/**
 * Calculate order quantity
 *
 * @param {*} logger
 * @param {*} symbolInfo
 * @param {*} balanceInfo
 * @param {*} indicators
 */
const getBuyOrderQuantity = (logger, symbolInfo, balanceInfo, indicators) => {
  const baseAssetPrice = +indicators.lastCandle.close;
  logger.info({ baseAssetPrice }, 'Retrieved latest asset price');

  const lotPrecision = symbolInfo.filterLotSize.stepSize.indexOf(1) - 1;
  const { freeBalance } = balanceInfo;

  const orderQuantityBeforeCommission = 1 / (+baseAssetPrice / freeBalance);

  const orderQuantity = parseFloat(
    _.floor(
      orderQuantityBeforeCommission -
        orderQuantityBeforeCommission * (0.1 / 100),
      lotPrecision
    )
  );

  if (orderQuantity <= 0) {
    return {
      result: false,
      message: 'Order quantity is less or equal to 0. Do not place an order.',
      baseAssetPrice,
      orderQuantity,
      freeBalance
    };
  }

  return {
    result: true,
    message: 'Calculated order quantity to buy.',
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
const getBuyOrderPrice = (logger, symbolInfo, orderQuantityInfo) => {
  const orderPrecision = symbolInfo.filterPrice.tickSize.indexOf(1) - 1;
  const orderPrice = parseFloat(
    _.floor(+orderQuantityInfo.baseAssetPrice, orderPrecision)
  );

  logger.info({ orderPrecision, orderPrice }, 'Calculated order price');

  // Notional value = contract size (order quantity) * underlying price (order price)
  if (
    orderQuantityInfo.orderQuantity * orderPrice <
    symbolInfo.filterMinNotional.minNotional
  ) {
    return {
      result: false,
      message: `Notional value is less than the minimum notional value. Do not place an order.`,
      orderPrice
    };
  }

  return {
    result: true,
    message: 'Calculated order price for buy.',
    orderPrice
  };
};

/**
 * Get open orders
 *
 * @param {*} logger
 * @param {*} symbol
 */
const getOpenOrders = async (logger, symbol) => {
  const openOrders = await binance.client.openOrders({
    symbol,
    recvWindow: 10000
  });
  logger.info({ openOrders }, 'Get open orders');

  return openOrders;
};

/**
 * Place stop loss limit order
 *
 * @param {*} logger
 * @param {*} symbolInfo
 * @param {*} balanceInfo
 * @param {*} indicators
 * @param {*} stopLossLimitInfo
 */
const placeStopLossLimitOrder = async (
  logger,
  symbolInfo,
  balanceInfo,
  indicators,
  stopLossLimitInfo
) => {
  logger.info('Started place stop loss limit order');
  const basePrice = +indicators.lastCandle.close;
  const balance = balanceInfo.freeBalance;
  const lotPrecision = symbolInfo.filterLotSize.stepSize.indexOf(1) - 1;
  const orderPrecision = symbolInfo.filterPrice.tickSize.indexOf(1) - 1;

  logger.info(
    { basePrice, balance, orderPrecision, stopLossLimitInfo },
    'Prepare params'
  );

  const stopPrice = roundDown(
    basePrice * +stopLossLimitInfo.stopPercentage,
    orderPrecision
  );
  const price = roundDown(
    basePrice * +stopLossLimitInfo.limitPercentage,
    orderPrecision
  );

  // Calculate quantity - commission
  const quantity = parseFloat(
    _.floor(balance - balance * (0.1 / 100), lotPrecision)
  );

  if (quantity <= +symbolInfo.filterLotSize.minQty) {
    return {
      result: false,
      message:
        `Order quantity is less or equal than the minimum quantity - ${symbolInfo.filterLotSize.minQty}. ` +
        `Do not place an order.`,
      quantity
    };
  }

  // Notional value = contract size (order quantity) * underlying price (order price)
  if (quantity * price < +symbolInfo.filterMinNotional.minNotional) {
    return {
      result: false,
      message: `Notional value is less than the minimum notional value. Do not place an order.`,
      quantity,
      price,
      notionValue: quantity * price,
      minNotional: +symbolInfo.filterMinNotional.minNotional
    };
  }

  const orderParams = {
    symbol: symbolInfo.symbol,
    side: 'sell',
    type: 'STOP_LOSS_LIMIT',
    quantity,
    price,
    timeInForce: 'GTC',
    stopPrice
  };

  logger.info({ orderParams }, 'Order params');

  slack.sendMessage(`Action: *STOP_LOSS_LIMIT*
  - Order Params: \`\`\`${JSON.stringify(orderParams, undefined, 2)}\`\`\`
  `);
  const orderResult = await binance.client.order(orderParams);

  logger.info({ orderResult }, 'Order result');

  cache.hset(
    'simple-stop-chaser-symbols',
    `${symbolInfo.symbol}-last-placed-stop-loss-order`,
    JSON.stringify(orderParams)
  );

  await slack.sendMessage(
    `Action Result: *STOP_LOSS_LIMIT*
    - Order Result: \`\`\`${JSON.stringify(orderResult, undefined, 2)}\`\`\``
  );

  return {
    result: true,
    message: `Placed stop loss order.`,
    orderParams,
    orderResult
  };
};

/**
 * Get balance from Binance
 *
 * @param {*} logger
 */
const getAccountInfo = async logger => {
  const accountInfo = await binance.client.accountInfo();

  accountInfo.balances = accountInfo.balances.reduce((acc, b) => {
    const balance = b;
    if (+balance.free > 0 || +balance.locked > 0) {
      acc.push(balance);
    }

    return acc;
  }, []);

  logger.info({ accountInfo }, 'Retrieved account information');
  return accountInfo;
};

/**
 * Get exchange info from Binance
 *
 * @param {*} logger
 */
const getExchangeSymbols = async logger => {
  const simpleStopChaserConfig = await getConfiguration(logger);

  const cachedExchangeInfo = await cache.hget(
    'simple-stop-chaser-common',
    'exchange-symbols'
  );

  if (_.isEmpty(cachedExchangeInfo) === false) {
    logger.info(
      { cachedExchangeInfo },
      'Retrieved exchange information from cache'
    );
    return JSON.parse(cachedExchangeInfo);
  }

  const exchangeInfo = await binance.client.exchangeInfo();

  let { supportFIATs } = simpleStopChaserConfig;
  if (!supportFIATs) {
    supportFIATs = config.get('jobs.simpleStopChaser.supportFIATs');
  }

  logger.info({ supportFIATs }, 'Support FIATs');
  const { symbols } = exchangeInfo;

  const exchangeSymbols = symbols.reduce((acc, symbol) => {
    if (new RegExp(supportFIATs.join('|')).test(symbol.symbol)) {
      acc.push(symbol.symbol);
    }

    return acc;
  }, []);

  await cache.hset(
    'simple-stop-chaser-common',
    'exchange-symbols',
    JSON.stringify(exchangeSymbols)
  );
  logger.info({ exchangeSymbols }, 'Retrieved exchange symbols');
  return exchangeSymbols;
};

/**
 * Flatten candle data
 *
 * @param {*} candles
 */
const flattenCandlesData = candles => {
  const openTime = [];
  const low = [];

  candles.forEach(candle => {
    openTime.push(+candle.openTime);
    low.push(+candle.low);
  });

  return {
    openTime,
    low
  };
};

/**
 * Get candles from Binance and determine buy signal with lowest price
 *
 * @param {*} logger
 */
const getIndicators = async (symbol, logger) => {
  const simpleStopChaserConfig = await getConfiguration(logger);

  const candles = await binance.client.candles({
    symbol,
    interval: simpleStopChaserConfig.candles.interval,
    limit: simpleStopChaserConfig.candles.limit
  });

  const [lastCandle] = candles.slice(-1);

  logger.info({ lastCandle }, 'Retrieved candles');

  const candlesData = flattenCandlesData(candles);

  // MIN
  const lowestClosed = _.min(candlesData.low);
  logger.info({ lowestClosed }, 'Retrieved lowest closed value result');

  // Cast string to number
  lastCandle.close = +lastCandle.close;

  const symbolInfo = await getSymbolInfo(logger, symbol);

  return {
    symbol,
    lowestClosed,
    lastCandle,
    symbolInfo
  };
};

/**
 * Determine action based on indicator
 *
 * @param {*} logger
 * @param {*} indicators
 */
const determineAction = async (logger, indicators) => {
  let action = 'wait';

  const { symbol, lowestClosed, lastCandle } = indicators;

  if (lastCandle.close <= lowestClosed) {
    action = 'buy';
    logger.info(
      { symbol, lowestClosed, close: lastCandle.close },
      "Current price is less than the lowest minimum price. Let's buy it."
    );
  } else {
    logger.warn(
      { symbol, lowestClosed, close: lastCandle.close },
      'Current price is higher than the lowest minimum price. Do not buy.'
    );
  }

  // Store last action
  const returnValue = {
    symbol,
    action,
    lastCandleClose: lastCandle.close,
    lowestClosed,
    timeUTC: moment().utc()
  };

  cache.hset(
    'simple-stop-chaser-symbols',
    `${symbol}-determine-action`,
    JSON.stringify(returnValue)
  );

  return returnValue;
};

/**
 * Place buy order based on signal
 *  Note: This method is optimised for USDT only.
 *
 * @param {*} logger
 * @param {*} indicators
 */
const placeBuyOrder = async (logger, indicators) => {
  logger.info('Start placing buy order');

  const simpleStopChaserConfig = await getConfiguration(logger);

  const { symbol, symbolInfo } = indicators;

  // 1. Cancel all orders
  await cancelOpenOrders(logger, symbol);

  // 3. Get balance for trade asset
  const { maxPurchaseAmount } = simpleStopChaserConfig;

  const balanceInfo = await getBuyBalance(logger, indicators, {
    maxPurchaseAmount
  });

  if (balanceInfo.result === false) {
    logger.warn({ balanceInfo }, 'getBuyBalance result');
    return balanceInfo;
  }
  logger.info({ balanceInfo }, 'getBuyBalance result');

  // 4. Get order quantity
  const orderQuantityInfo = getBuyOrderQuantity(
    logger,
    symbolInfo,
    balanceInfo,
    indicators
  );
  if (orderQuantityInfo.result === false) {
    logger.warn({ orderQuantityInfo }, 'getBuyOrderQuantity result');
    return orderQuantityInfo;
  }
  logger.info({ orderQuantityInfo }, 'getBuyOrderQuantity result');

  // 5. Get order price
  const orderPriceInfo = getBuyOrderPrice(
    logger,
    symbolInfo,
    orderQuantityInfo
  );

  if (orderPriceInfo.result === false) {
    logger.warn({ orderPriceInfo }, 'getBuyOrderPrice result');
    return orderPriceInfo;
  }
  logger.info({ orderPriceInfo }, 'getBuyOrderPrice result');

  // 6. Place order
  const orderParams = {
    symbol,
    side: 'buy',
    type: 'LIMIT',
    quantity: orderQuantityInfo.orderQuantity,
    price: orderPriceInfo.orderPrice,
    timeInForce: 'GTC'
  };

  slack.sendMessage(`${symbol} Action: *Buy*
  - Free Balance: ${orderQuantityInfo.freeBalance}
  - Order Quantity: ${orderQuantityInfo.orderQuantity}
  - Order Params: \`\`\`${JSON.stringify(orderParams, undefined, 2)}\`\`\`
  `);

  logger.info({ orderParams }, 'Buy order params');
  const orderResult = await binance.client.order(orderParams);

  logger.info({ orderResult }, 'Buy order result');
  await cache.hset(
    'simple-stop-chaser-symbols',
    `${symbol}-last-placed-order`,
    JSON.stringify({ ...orderParams, timeUTC: moment().utc() })
  );

  await mongo.upsertOne(
    logger,
    'simple-stop-chaser-symbols',
    {
      key: `${symbol}-last-buy-price`
    },
    {
      key: `${symbol}-last-buy-price`,
      lastBuyPrice: orderPriceInfo.orderPrice
    }
  );

  await slack.sendMessage(
    `${symbol} Action Result: *Buy*
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

  const simpleStopChaserConfig = await getConfiguration(logger);

  let returnValue;

  const { symbol, symbolInfo } = indicators;

  const { stopLossLimit: stopLossLimitConfig } = simpleStopChaserConfig;

  // 1. Get open orders
  const openOrders = await getOpenOrders(logger, symbol);
  cache.hset(
    'simple-stop-chaser-symbols',
    `${symbol}-open-orders`,
    JSON.stringify(openOrders)
  );

  // 1-1. Get last buy price and make sure it is within minimum profit range.
  const lastBuyPriceDoc = await mongo.findOne(
    logger,
    'simple-stop-chaser-symbols',
    {
      key: `${symbol}-last-buy-price`
    }
  );

  const cachedLastBuyPrice =
    lastBuyPriceDoc && lastBuyPriceDoc.lastBuyPrice
      ? lastBuyPriceDoc.lastBuyPrice
      : null;
  logger.debug({ cachedLastBuyPrice }, 'Last buy price');

  if (
    _.isEmpty(openOrders) &&
    (!cachedLastBuyPrice || +cachedLastBuyPrice <= 0)
  ) {
    returnValue = {
      result: false,
      message:
        'Open order cannot be found and cannot get last buy price from the cache. Wait.'
    };
    // Delete sell signal
    cache.hdel(
      'simple-stop-chaser-symbols',
      `${symbol}-chase-stop-loss-limit-order-sell-signal`
    );
    cache.hdel(
      'simple-stop-chaser-symbols',
      `${symbol}-chase-stop-loss-limit-order-sell-signal-result`
    );

    return returnValue;
  }

  const lastBuyPrice = +cachedLastBuyPrice;

  logger.info({ lastBuyPrice }, 'Retrieved last buy price');

  const lastCandleClose = +indicators.lastCandle.close;
  logger.info({ lastCandleClose }, 'Retrieved last closed price');

  const calculatedLastBuyPrice =
    lastBuyPrice * +stopLossLimitConfig.lastBuyPercentage;

  const sellSignalInfo = {
    lastBuyPrice,
    lastCandleClose,
    calculatedLastBuyPrice
  };

  cache.hset(
    'simple-stop-chaser-symbols',
    `${symbol}-chase-stop-loss-limit-order-sell-signal`,
    JSON.stringify({
      ...sellSignalInfo,
      timeUTC: moment().utc()
    })
  );

  // 2. If there is no open orders
  if (openOrders.length === 0) {
    logger.info(
      { openOrders, lastBuyPrice },
      'There is no open orders but found the last buy price. Try to get a selling signal.'
    );

    //  2-1. Get current balance of symbol.
    //    If there is not enough balance, then remove last buy price and return.
    const balanceInfo = await getSellBalance(
      logger,
      symbolInfo,
      indicators,
      stopLossLimitConfig
    );
    if (balanceInfo.result === false) {
      logger.warn({ balanceInfo }, 'getSellBalance result');
      cache.hset(
        'simple-stop-chaser-symbols',
        `${symbol}-chase-stop-loss-limit-order-sell-signal-result`,
        JSON.stringify({
          ...sellSignalInfo,
          ...balanceInfo,
          timeUTC: moment().utc()
        })
      );
      return balanceInfo;
    }
    logger.info({ balanceInfo }, 'getSellBalance result');

    // 2-2. Compare last buy price is within minimum profit range.
    //  If not cached for some reason, it will just place stop-loss-limit order.
    if (lastCandleClose < calculatedLastBuyPrice) {
      returnValue = {
        result: false,
        message: 'Current price is lower than the minimum selling price. Wait.',
        ...sellSignalInfo
      };
      cache.hset(
        'simple-stop-chaser-symbols',
        `${symbol}-chase-stop-loss-limit-order-sell-signal-result`,
        JSON.stringify({ ...returnValue, timeUTC: moment().utc() })
      );

      return returnValue;
    }

    logger.info(
      { lastCandleClose, lastBuyPrice, calculatedLastBuyPrice },
      `Last buy price is higher than the expected price. Let's check the balance.`
    );

    //  2-3. Place stop loss order
    const stopLossLimitOrderInfo = await placeStopLossLimitOrder(
      logger,
      symbolInfo,
      balanceInfo,
      indicators,
      stopLossLimitConfig
    );
    cache.hset(
      'simple-stop-chaser-symbols',
      `${symbol}-chase-stop-loss-limit-order-sell-signal-result`,
      JSON.stringify({
        ...sellSignalInfo,
        ...stopLossLimitOrderInfo,
        timeUTC: moment().utc()
      })
    );
    // 2-4. Wait for my money
    return stopLossLimitOrderInfo;
  }

  logger.info(
    { openOrders, lastBuyPrice },
    'There is an open order. Try to check profit.'
  );

  const order = openOrders[0];

  // 3. If the order is not stop loss limit order, then do nothing
  if (order.type !== 'STOP_LOSS_LIMIT') {
    // Delete sell signal
    cache.hdel(
      'simple-stop-chaser-symbols',
      `${symbol}-chase-stop-loss-limit-order-open-order-result`
    );
    return {
      result: false,
      message: 'Order is not STOP_LOSS_LIMIT. Do nothing.'
    };
  }

  // 4. If order's stop price is less than current price * limit percentage
  //      It means the price is increase more than expected, so cancel it and let's get more money.
  //      Don't worry about the cancel. It will place another STOP-LOSS-LIMIT order.

  const limitPrice =
    +indicators.lastCandle.close * stopLossLimitConfig.limitPercentage;

  const openOrderInfo = {
    stopPrice: order.stopPrice,
    lastCandleClose: +indicators.lastCandle.close,
    limitPercentage: stopLossLimitConfig.limitPercentage,
    limitPrice,
    message: '',
    timeUTC: moment().utc()
  };

  if (order.stopPrice < limitPrice) {
    //  4-1. Cancel order
    openOrderInfo.message =
      'The stop price is lower than the limit price. ' +
      'Cancel previous order and place new stop loss limit order.';

    await cancelOpenOrders(logger, symbol);
  } else {
    openOrderInfo.message =
      'The stop price is higher than the limit price. Wait.';
  }
  logger.info({ openOrderInfo });

  cache.hset(
    'simple-stop-chaser-symbols',
    `${symbol}-chase-stop-loss-limit-order-open-order-result`,
    JSON.stringify(openOrderInfo)
  );

  return {
    result: true,
    message: 'Finished to process chaseStopLossLimitOrder.'
  };
};

module.exports = {
  getConfiguration,
  getAccountInfo,
  getExchangeSymbols,
  flattenCandlesData,
  getIndicators,
  determineAction,
  placeBuyOrder,
  chaseStopLossLimitOrder,
  cancelOpenOrders,
  getSymbolInfo,
  getBuyBalance,
  getSellBalance,
  getBuyOrderQuantity,
  getBuyOrderPrice,
  getOpenOrders,
  placeStopLossLimitOrder
};
