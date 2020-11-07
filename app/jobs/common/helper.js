/* eslint-disable no-restricted-properties */
const _ = require('lodash');
const cache = require('../../helpers/cache');

/**
 * Cancel any open orders to get available balance
 *
 * @param {*} logger
 * @param {*} symbol
 */
const cancelOpenOrders = async (logger, binance, symbol) => {
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
 * Get symbol information
 *
 * @param {*} logger
 * @param {*} binance
 * @param {*} symbol
 */
const getSymbolInfo = async (logger, binance, symbol) => {
  const cachedSymbolInfo = await cache.get(`symbol-info-${symbol}`);
  if (cachedSymbolInfo) {
    logger.info({ cachedSymbolInfo }, 'Retrieved symbol info from cache');
    return JSON.parse(cachedSymbolInfo);
  }

  logger.info({}, 'Request exchange info from Binance');
  const exchangeInfo = await binance.client.exchangeInfo();

  logger.info({}, 'Retrieved exchange info from Binance');
  const symbolInfo =
    _.filter(exchangeInfo.symbols, s => {
      return s.symbol === symbol;
    })[0] || {};

  symbolInfo.filterLotSize = _.filter(symbolInfo.filters, f => f.filterType === 'LOT_SIZE')[0] || {};
  symbolInfo.filterPrice = _.filter(symbolInfo.filters, f => f.filterType === 'PRICE_FILTER')[0] || {};
  symbolInfo.filterPercent = _.filter(symbolInfo.filters, f => f.filterType === 'PERCENT_PRICE')[0] || {};
  symbolInfo.filterMinNotional = _.filter(symbolInfo.filters, f => f.filterType === 'MIN_NOTIONAL')[0] || {};

  const success = await cache.set(`symbol-info-${symbol}`, JSON.stringify(symbolInfo));
  logger.info({ success, symbolInfo }, 'Retrieved symbol info from Binance');
  return symbolInfo;
};

/**
 * Retrieve balance for trade asset based on the trade action
 *
 * @param {*} logger
 * @param {*} binance
 * @param {*} symbolInfo
 * @param {*} tradeAction
 */
const getBalance = async (logger, binance, symbolInfo, tradeAction) => {
  // 1. Get account info
  const accountInfo = await binance.client.accountInfo({ recvWindow: 10000 });
  logger.info('Retrieved Account info');

  const tradeAsset = tradeAction === 'buy' ? symbolInfo.quoteAsset : symbolInfo.baseAsset;
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
  if (tradeAction === 'buy' && freeBalance < +symbolInfo.filterMinNotional.minNotional) {
    logger.error({ freeBalance }, 'Balance is less than minimum notional.');

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
 * @param {*} tradeAction
 * @param {*} balanceInfo
 * @param {*} percentage
 * @param {*} indicators
 */
const getOrderQuantity = (logger, symbolInfo, tradeAction, balanceInfo, percentage, indicators) => {
  const baseAssetPrice = +indicators.lastCandle.close;
  logger.info({ baseAssetPrice }, 'Retrieved latest asset price');

  const lotPrecision = symbolInfo.filterLotSize.stepSize.indexOf(1) - 1;
  const { freeBalance } = balanceInfo;

  let orderQuantity = 0;

  if (tradeAction === 'buy') {
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

  if (tradeAction === 'sell') {
    const orderQuantityBeforeCommission = freeBalance * (percentage / 100);
    orderQuantity = +(orderQuantityBeforeCommission - orderQuantityBeforeCommission * (0.1 / 100)).toFixed(
      lotPrecision
    );

    if (orderQuantity <= +symbolInfo.filterLotSize.minQty) {
      logger.error(
        { freeBalance, symbolInfo },
        `Order quantity is less or equal than minimum quantity - ${symbolInfo.filterLotSize.minQty}.`
      );
      return {
        result: false,
        message: `Order quantity is less or equal than minimum quantity - ${symbolInfo.filterLotSize.minQty}.`,
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

  // Notional value = contract size (order quantity) * underlying price (order price)
  if (orderQuantityInfo.orderQuantity * orderPrice < symbolInfo.filterMinNotional.minNotional) {
    return {
      result: false,
      message: `Notional value is less than minimum notional value.`,
      orderPrice
    };
  }

  return {
    result: true,
    message: `Calculated notional value`,
    orderPrice
  };
};

/**
 * Get open orders
 *
 * @param {*} logger
 * @param {*} binance
 * @param {*} symbol
 */
const getOpenOrders = async (logger, binance, symbol) => {
  const openOrders = await binance.client.openOrders({ symbol, recvWindow: 10000 });
  logger.info({ openOrders }, 'Get open orders');

  return openOrders;
};

/**
 * Calculate round down
 *
 * @param {*} number
 * @param {*} decimals
 */
const roundDown = (number, decimals) => {
  return Math.floor(number * Math.pow(10, decimals)) / Math.pow(10, decimals);
};

/**
 * Place stop loss limit order
 *
 * @param {*} logger
 * @param {*} binance
 * @param {*} slack
 * @param {*} symbolInfo
 * @param {*} balanceInfo
 * @param {*} indicators
 * @param {*} stopLossLimitInfo
 */
const placeStopLossLimitOrder = async (
  logger,
  binance,
  slack,
  symbolInfo,
  balanceInfo,
  indicators,
  stopLossLimitInfo
) => {
  logger.info({}, 'Started place stop loss limit order');
  const basePrice = +indicators.lastCandle.close;
  const balance = balanceInfo.freeBalance;
  const lotPrecision = symbolInfo.filterLotSize.stepSize.indexOf(1) - 1;
  const orderPrecision = symbolInfo.filterPrice.tickSize.indexOf(1) - 1;

  logger.info({ basePrice, balance, orderPrecision, stopLossLimitInfo }, 'Prepare params');

  const stopPrice = roundDown(basePrice * +stopLossLimitInfo.stopPercentage, orderPrecision);
  const price = roundDown(basePrice * +stopLossLimitInfo.limitPercentage, orderPrecision);

  // Calculate quantity - commission
  const quantity = +(balance - balance * (0.1 / 100)).toFixed(lotPrecision);

  if (quantity <= +symbolInfo.filterLotSize.minQty) {
    logger.error(
      { quantity },
      `Order quantity is less or equal than minimum quantity - ${symbolInfo.filterLotSize.minQty}.`
    );
    return {
      result: false,
      message: `Order quantity is less or equal than minimum quantity - ${symbolInfo.filterLotSize.minQty}.`,
      quantity
    };
  }

  // Notional value = contract size (order quantity) * underlying price (order price)
  if (quantity * price < symbolInfo.filterMinNotional.minNotional) {
    logger.error(
      { quantity, price, minNotional: symbolInfo.filterMinNotional.minNotional },
      `Notional value is less than minimum notional value.`
    );
    return {
      result: false,
      message: `Notional value is less than minimum notional value.`,
      quantity,
      price,
      notionValue: quantity * price,
      minNotional: symbolInfo.filterMinNotional.minNotional
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
  const orderResult = binance.client.order(orderParams);

  logger.info({ orderResult }, 'Order result');

  await slack.sendMessage(
    `Action Result: *STOP_LOSS_LIMIT*
    - Order Result: \`\`\`${JSON.stringify(orderResult, undefined, 2)}\`\`\``
  );

  return orderResult;
};

module.exports = {
  cancelOpenOrders,
  getSymbolInfo,
  getBalance,
  getOrderQuantity,
  getOrderPrice,
  getOpenOrders,
  placeStopLossLimitOrder
};
