const _ = require('lodash');
const moment = require('moment');
const { binance, messenger, cache } = require('../../../helpers');
const { roundDown } = require('../../trailingTradeHelper/util');
const config = require('config');
const {
  getAndCacheOpenOrdersForSymbol,
  getAccountInfoFromAPI,
  isExceedAPILimit,
} = require('../../trailingTradeHelper/common');

const retrieveLastBuyOrder = async (symbol) => {
  const cachedLastBuyOrder =
    JSON.parse(await cache.get(`${symbol}-last-buy-order`)) || {};

  return _.isEmpty(cachedLastBuyOrder);
};

/**
 * Place a buy order if has enough balance
 *
 * @param {*} logger
 * @param {*} rawData
 */
const execute = async (logger, rawData) => {
  const data = rawData;

  const {
    symbol,
    isLocked,
    symbolInfo: {
      baseAsset,
      quoteAsset,
      filterLotSize: { stepSize },
      filterPrice: { tickSize },
      filterMinNotional: { minNotional }
    },
    symbolConfiguration: {
      buy: {
        enabled: tradingEnabled,
        maxPurchaseAmount,
        minPurchaseAmount,
        stopPercentage,
        limitPercentage
      },
      strategyOptions: { huskyOptions: { buySignal } }
    },
    action,
    quoteAssetBalance: { free: quoteAssetFreeBalance },
    buy: { currentPrice, openOrders },
    indicators: { trendDiff }
  } = data;

  if (isLocked) {
    logger.info(
      { isLocked },
      'Symbol is locked, do not process place-buy-order'
    );
    return data;
  }

  if (action !== 'buy') {
    logger.info(`Do not process a buy order because action is not 'buy'.`);
    return data;
  }


  const language = config.get('language');
  const { coin_wrapper: { _actions } } = require(`../../../../public/${language}.json`);

  if (!await retrieveLastBuyOrder(symbol)) {
    data.buy.processMessage = "cant buy, found open order in cache";
    return data;
  }

  if (openOrders.length > 0) {
    data.buy.processMessage = action.action_open_orders[1] + symbol + '.' + _actions.action_open_orders[2];
    data.buy.updatedAt = moment().utc();

    return data;
  }

  if (maxPurchaseAmount <= 0) {
    data.buy.processMessage =
      _actions.action_max_purchase_undefined;
    data.buy.updatedAt = moment().utc();

    return data;
  }

  logger.info(
    { debug: true, currentPrice, openOrders },
    'Attempting to place buy order'
  );

  const lotPrecision = parseFloat(stepSize) === 1 ? 0 : stepSize.indexOf(1) - 1;
  const pricePrecision =
    parseFloat(tickSize) === 1 ? 0 : tickSize.indexOf(1) - 1;

  let freeBalance = parseFloat(_.floor(quoteAssetFreeBalance, pricePrecision));

  logger.info({ freeBalance }, 'Free balance');
  if (freeBalance > maxPurchaseAmount) {
    freeBalance = maxPurchaseAmount;
    logger.info({ freeBalance }, 'Free balance after adjust');
  }

  if (freeBalance < parseFloat(minPurchaseAmount)) {
    freeBalance = minPurchaseAmount;
    logger.info({ freeBalance }, 'Free balance after adjust');
  }

  if (freeBalance < parseFloat(minNotional)) {
    data.buy.processMessage = _actions.action_dont_place_order[1] + quoteAsset + _actions.action_dont_place_order[2] + baseAsset + '.';
    data.buy.updatedAt = moment().utc();

    return data;
  }


  const stopPrice = roundDown(currentPrice * stopPercentage, pricePrecision);
  const limitPrice = roundDown(currentPrice * limitPercentage, pricePrecision);

  logger.info({ stopPrice, limitPrice }, 'Stop price and limit price');

  const orderQuantityBeforeCommission = 1 / (limitPrice / freeBalance);
  logger.info(
    { orderQuantityBeforeCommission },
    'Order quantity before commission'
  );
  const orderQuantity = parseFloat(
    _.floor(
      orderQuantityBeforeCommission -
      orderQuantityBeforeCommission * (0.1 / 100),
      lotPrecision
    )
  );

  logger.info({ orderQuantity }, 'Order quantity after commission');

  if (orderQuantity * limitPrice < parseFloat(minNotional)) {
    data.buy.processMessage =
      _actions.action_dont_place_order_calc[1] + quoteAsset +
      _actions.action_dont_place_order_calc[2] + baseAsset + _actions.action_dont_place_order_calc[3];
    data.buy.updatedAt = moment().utc();

    return data;
  }

  if (tradingEnabled !== true) {
    data.buy.processMessage = _actions.action_trading_for_disabled[1] + symbol + _actions.action_trading_for_disabled[2];
    data.buy.updatedAt = moment().utc();

    return data;
  }

  if (isExceedAPILimit(logger)) {
    data.buy.processMessage = _actions.action_api_exceed;
    data.buy.updatedAt = moment().utc();

    return data;
  }

  if (buySignal) {
    if (Math.sign(trendDiff) == -1) {
      data.buy.processMessage = "Trend is going down, cancelling order";
      data.buy.updatedAt = moment().utc();

      return data;
    }
  }


  const orderParams = {
    symbol,
    side: 'buy',
    type: 'STOP_LOSS_LIMIT',
    quantity: orderQuantity,
    stopPrice,
    price: limitPrice,
    timeInForce: 'GTC'
  };

  messenger.sendMessage(
    symbol, orderParams, 'PLACE_BUY'
  );

  logger.info(
    { debug: true, function: 'order', orderParams },
    'Buy order params'
  );
  const orderResult = await binance.client.order(orderParams);

  logger.info({ orderResult }, 'Order result');

  // Set last buy order to be checked over infinite minutes until callback is received
  await cache.set(`${symbol}-last-buy-order`, JSON.stringify(orderResult));

  // Get open orders and update cache
  data.openOrders = await getAndCacheOpenOrdersForSymbol(logger, symbol);
  data.buy.openOrders = data.openOrders.filter(
    o => o.side.toLowerCase() === 'buy'
  );

  // Refresh account info
  data.accountInfo = await getAccountInfoFromAPI(logger);

  messenger.sendMessage(
    symbol, orderResult, 'PLACE_BUY_DONE'
  );
  data.buy.processMessage = _actions.action_placed_new_order;
  data.buy.updatedAt = moment().utc();

  // Save last buy price
  return data;
};

module.exports = { execute };
