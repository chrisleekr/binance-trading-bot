const _ = require('lodash');
const moment = require('moment');
const { binance, messenger, mongo } = require('../../../helpers');
const {
  getAndCacheOpenOrdersForSymbol,
  getAccountInfoFromAPI,
  isExceedAPILimit,
  disableAction,
  getAPILimit
} = require('../../trailingTradeHelper/common');
const { getConfiguration } = require('../../trailingTradeHelper/configuration');
const config = require('config');

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
        triggerPercentage,
        stopLoss: {
          orderType: sellStopLossOrderType,
          disableBuyMinutes: sellStopLossDisableBuyMinutes
        },
        stakeCoinEnabled
      }
    },
    action,
    sell: { currentPrice, openOrders, lastQtyBought }
  } = data;

  if (isLocked) {
    logger.info(
      { isLocked },
      'Symbol is locked, do not process place-sell-stop-loss-order'
    );
    return data;
  }

  if (action == 'sell-stop-loss' || action == 'sell-profit') {
    const language = config.get('language');
    const { coin_wrapper: { _actions } } = require(`../../../../public/${language}.json`);

    if (openOrders.length > 0) {
      data.sell.processMessage = action.action_open_orders[1] + symbol + '.' + _actions.action_open_orders[2];
      data.sell.updatedAt = moment().utc();

      return data;
    }

    const lotPrecision = parseFloat(stepSize) === 1 ? 0 : stepSize.indexOf(1) - 1;

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

    var calculatedPrice = orderQuantity * currentPrice;
    if (calculatedPrice < parseFloat(minNotional)) {
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

    // Currently, only support market order for stop-loss.
    const allowedOrderTypes = ['market'];
    if (allowedOrderTypes.includes(sellStopLossOrderType) === false) {
      data.sell.processMessage = _actions.action_unknown_order[1] + sellStopLossOrderType + _actions.action_unknown_order[2];
      data.sell.updatedAt = moment().utc();

      return data;
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

    if (orderQuantity == 0) {
      messenger.errorMessage("Trying to sell at stop loss but order quantity IS: " + orderQuantity);
      data.sell.processMessage = "I can't sell at stop loss because Quantity is 0. You would lost your staked coins. Please, sell manually.";
      data.sell.updatedAt = moment().utc();
      return data;
    }
    const orderParams = {
      symbol,
      side: 'sell',
      type: 'MARKET',
      quantity: orderQuantity
    };

    logger.info(
      { debug: true, function: 'order', orderParams },
      'Sell market order params'
    );
    const orderResult = await binance.client.order(orderParams);

    logger.info({ orderResult }, 'Market order result');

    if (action == 'sell-stop-loss') {
      messenger.sendMessage(
        symbol, null, 'SELL_STOP_LOSS');
      // Temporary disable action
      await disableAction(
        symbol,
        {
          disabledBy: 'stop loss',
          message: _actions.action_disabled_stop_loss,
          canResume: true,
          canRemoveLastBuyPrice: true
        },
        sellStopLossDisableBuyMinutes * 60
      );
    }

    await mongo.deleteOne(logger, 'trailing-trade-symbols', {
      key: `${symbol}-last-buy-price`
    });

    // Get open orders and update cache
    data.openOrders = await getAndCacheOpenOrdersForSymbol(logger, symbol);
    data.sell.openOrders = data.openOrders.filter(
      o => o.side.toLowerCase() === 'sell'
    );

    // Refresh account info
    data.accountInfo = await getAccountInfoFromAPI(logger);
    data.sell.processMessage = _actions.action_sell_stop_loss;
    data.sell.updatedAt = moment().utc();

    return data;
  } else {
    logger.info(
      `Do not process a sell order because action is not 'sell-stop-loss'.`
    );
    return data;
  }
};

module.exports = { execute };
