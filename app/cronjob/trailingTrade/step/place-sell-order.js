const _ = require('lodash');
const moment = require('moment');
const { binance, cache, mongo, messenger } = require('../../../helpers');
const { roundDown } = require('../../trailingTradeHelper/util');
const config = require('config');
const {
  getAndCacheOpenOrdersForSymbol,
  getAccountInfoFromAPI,
  isExceedAPILimit,
  getAPILimit
} = require('../../trailingTradeHelper/common');

/**
 * Place a sell order if has enough balance
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
      filterLotSize: { stepSize, minQty, maxQty },
      filterPrice: { tickSize },
      filterMinNotional: { minNotional }
    },
    symbolConfiguration: {
      sell: { enabled: tradingEnabled, stopPercentage, limitPercentage, triggerPercentage, stakeCoinEnabled },
      strategyOptions: { huskyOptions: { sellSignal } }
    },
    action,
    sell: { currentPrice, openOrders, lastQtyBought },
    indicators: { trendDiff }
  } = data;

  if (isLocked) {
    logger.info(
      { isLocked },
      'Symbol is locked, do not process place-sell-order'
    );
    return data;
  }

  if (action !== 'sell') {
    logger.info(`Do not process a sell order because action is not 'sell'.`);
    return data;
  }

  const language = config.get('language');
  const { coin_wrapper: { _actions } } = require(`../../../../public/${language}.json`);

  if (openOrders.length > 0) {
    data.sell.processMessage = action.action_open_orders[1] + symbol + '.' + _actions.action_open_orders[2];
    data.sell.updatedAt = moment().utc();

    return data;
  }

  const lotPrecision = parseFloat(stepSize) === 1 ? 0 : stepSize.indexOf(1) - 1;
  const pricePrecision =
    parseFloat(tickSize) === 1 ? 0 : tickSize.indexOf(1) - 1;

  const stopPrice = roundDown(currentPrice * stopPercentage, pricePrecision);
  const limitPrice = roundDown(currentPrice * limitPercentage, pricePrecision);

  const freeBalance = parseFloat(_.floor(lastQtyBought, lotPrecision));
  logger.info({ freeBalance }, 'Free balance');

  let orderQuantity = parseFloat(
    _.floor(freeBalance - freeBalance * (0.1 / 100), lotPrecision)
  );

  if (orderQuantity <= parseFloat(minQty)) {
    data.sell.processMessage =
      _actions.action_order_minimum_qty[1] + minQty +
      _actions.action_order_minimum_qty[2];
    data.sell.updatedAt = moment().utc();

    return data;
  }
  if (orderQuantity > parseFloat(maxQty)) {
    orderQuantity = parseFloat(maxQty);
  }

  if (orderQuantity * limitPrice < parseFloat(minNotional)) {
    data.sell.processMessage = _actions.action_less_than_nominal;
    data.sell.updatedAt = moment().utc();

    return data;
  }

  if (tradingEnabled !== true) {
    data.buy.processMessage = _actions.action_trading_for_disabled[1] + symbol + _actions.action_trading_for_disabled[2];
    data.sell.updatedAt = moment().utc();

    return data;
  }

  if (isExceedAPILimit(logger)) {
    data.buy.processMessage = _actions.action_api_exceed;
    data.sell.updatedAt = moment().utc();

    return data;
  }


  if (sellSignal) {
    if (Math.sign(trendDiff) == 1) {
      data.buy.processMessage = "Trend is going up, cancelling order";
      data.buy.updatedAt = moment().utc();

      return data;
    }
  }

  if (stakeCoinEnabled) {
    const reduceSellTrigger = (triggerPercentage * 100) - 100;
    const amountOfProfitToReduceToStake = (orderQuantity / 100) * reduceSellTrigger
    const calculatedOrderQuantity = parseFloat(
      _.floor((orderQuantity - amountOfProfitToReduceToStake), lotPrecision)
    );

    if ((calculatedOrderQuantity * currentPrice) > parseFloat(minNotional)) {
      orderQuantity = calculatedOrderQuantity;
    };
  }

  const orderParams = {
    symbol,
    side: 'sell',
    type: 'STOP_LOSS_LIMIT',
    quantity: orderQuantity,
    stopPrice,
    price: limitPrice,
    timeInForce: 'GTC'
  };

  messenger.sendMessage(
    symbol, orderParams, 'PLACE_SELL'
  );

  logger.info(
    { debug: true, function: 'order', orderParams },
    'Sell order params'
  );
  const orderResult = await binance.client.order(orderParams);

  logger.info({ orderResult }, 'Order result');

  await cache.set(`${symbol}-last-sell-order`, JSON.stringify(orderResult), 60);

  // Get open orders and update cache
  data.openOrders = await getAndCacheOpenOrdersForSymbol(logger, symbol);
  data.sell.openOrders = data.openOrders.filter(
    o => o.side.toLowerCase() === 'sell'
  );

  // Refresh account info
  data.accountInfo = await getAccountInfoFromAPI(logger);

  messenger.sendMessage(
    symbol, orderResult, 'PLACE_SELL_DONE'
  );
  data.buy.processMessage = _actions.action_placed_new_sell_order;
  data.sell.updatedAt = moment().utc();

  return data;
};

module.exports = { execute };
