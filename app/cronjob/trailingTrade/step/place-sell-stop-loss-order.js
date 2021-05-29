const _ = require('lodash');
const moment = require('moment');
const { binance, messenger } = require('../../../helpers');
const {
  getAndCacheOpenOrdersForSymbol,
  getAccountInfoFromAPI,
  isExceedAPILimit,
  disableAction,
  getAPILimit
} = require('../../trailingTradeHelper/common');
const { getConfiguration } = require('../../trailingTradeHelper/configuration');

/**
 * Place a sell stop-loss order when the current price reached stop-loss trigger price
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
      filterMinNotional: { minNotional }
    },
    symbolConfiguration: {
      sell: {
        enabled: tradingEnabled,
        stopLoss: {
          orderType: sellStopLossOrderType,
          disableBuyMinutes: sellStopLossDisableBuyMinutes
        }
      }
    },
    action,
    baseAssetBalance: { free: baseAssetFreeBalance },
    sell: { currentPrice, openOrders }
  } = data;

  if (isLocked) {
    logger.info(
      { isLocked },
      'Symbol is locked, do not process place-sell-stop-loss-order'
    );
    return data;
  }

  if (action !== 'sell-stop-loss') {
    logger.info(
      `Do not process a sell order because action is not 'sell-stop-loss'.`
    );
    return data;
  }

  if (openOrders.length > 0) {
    data.sell.processMessage = `There are open orders for ${symbol}. Do not place an order.`;
    data.sell.updatedAt = moment().utc();

    return data;
  }

  const lotPrecision = parseFloat(stepSize) === 1 ? 0 : stepSize.indexOf(1) - 1;

  const freeBalance = parseFloat(_.floor(baseAssetFreeBalance, lotPrecision));
  logger.info({ freeBalance }, 'Free balance');

  let orderQuantity = parseFloat(
    _.floor(freeBalance - freeBalance * (0.1 / 100), lotPrecision)
  );

  if (orderQuantity <= parseFloat(minQty)) {
    data.sell.processMessage =
      `Order quantity is less or equal than the minimum quantity - ${minQty}. ` +
      `Do not place a stop-loss order.`;
    data.sell.updatedAt = moment().utc();

    return data;
  }

  if (orderQuantity > parseFloat(maxQty)) {
    orderQuantity = parseFloat(maxQty);
  }

  var calculatedPrice = orderQuantity * currentPrice;
  if (calculatedPrice < parseFloat(minNotional)) {
    data.sell.processMessage =
      `Notional value is less than the minimum notional value. ` +
      `Do not place a stop-loss order.`;
    data.sell.updatedAt = moment().utc();

    return data;
  }

  if (tradingEnabled !== true) {
    data.sell.processMessage = `Trading for ${symbol} is disabled. Do not place a stop-loss order.`;
    data.sell.updatedAt = moment().utc();

    return data;
  }

  if (isExceedAPILimit(logger)) {
    data.sell.processMessage = `Binance API limit has been exceeded. Do not place a stop-loss order.`;
    data.sell.updatedAt = moment().utc();

    return data;
  }

  // Currently, only support market order for stop-loss.
  const allowedOrderTypes = ['market'];
  if (allowedOrderTypes.includes(sellStopLossOrderType) === false) {
    data.sell.processMessage = `Unknown order type ${sellStopLossOrderType}. Do not place a stop-loss order.`;
    data.sell.updatedAt = moment().utc();

    return data;
  }

  const orderParams = {
    symbol,
    side: 'sell',
    type: 'MARKET',
    quantity: orderQuantity
  };

  messenger.sendMessage(
    symbol, null, 'SELL_STOP_LOSS');

  logger.info(
    { debug: true, function: 'order', orderParams },
    'Sell market order params'
  );
  const orderResult = await binance.client.order(orderParams);

  logger.info({ orderResult }, 'Market order result');

  // Temporary disable action
  await disableAction(
    symbol,
    {
      disabledBy: 'stop loss',
      message: 'Temporary disabled by stop loss',
      canResume: true,
      canRemoveLastBuyPrice: true
    },
    sellStopLossDisableBuyMinutes * 60
  );

  // Get open orders and update cache
  data.openOrders = await getAndCacheOpenOrdersForSymbol(logger, symbol);
  data.sell.openOrders = data.openOrders.filter(
    o => o.side.toLowerCase() === 'sell'
  );

  // Refresh account info
  data.accountInfo = await getAccountInfoFromAPI(logger);

  messenger.sendMessage(
              symbol, orderResult, 'SELL_STOP_LOSS');
  data.sell.processMessage = `Placed new market order for selling.`;
  data.sell.updatedAt = moment().utc();

  return data;
};

module.exports = { execute };
