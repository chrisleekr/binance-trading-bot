const _ = require('lodash');
const moment = require('moment');
const { binance, slack } = require('../../../helpers');
const {
  getAndCacheOpenOrdersForSymbol,
  getAccountInfoFromAPI,
  isExceedAPILimit,
  disableAction,
  getAPILimit
} = require('../../trailingTradeHelper/common');
const {
  saveSymbolGridTrade
} = require('../../trailingTradeHelper/configuration');

/**
 * Set message and return data
 *
 * @param {*} logger
 * @param {*} rawData
 * @param {*} processMessage
 * @returns
 */
const setMessage = (logger, rawData, processMessage) => {
  const data = rawData;

  logger.info({ data, saveLog: true }, processMessage);
  data.sell.processMessage = processMessage;
  data.sell.updatedAt = moment().utc();
  return data;
};

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
      buy: { gridTrade: buyGridTrade },
      sell: {
        enabled: tradingEnabled,
        gridTrade: sellGridTrade,
        stopLoss: {
          orderType: sellStopLossOrderType,
          disableBuyMinutes: sellStopLossDisableBuyMinutes
        }
      }
    },
    action,
    baseAssetBalance: { free: baseAssetFreeBalance },
    sell: { currentPrice, openOrders },
    canDisable
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
    return setMessage(
      logger,
      data,
      `There are open orders for ${symbol}. Do not place an order.`
    );
  }

  const lotPrecision = parseFloat(stepSize) === 1 ? 0 : stepSize.indexOf(1) - 1;

  const freeBalance = parseFloat(_.floor(baseAssetFreeBalance, lotPrecision));
  logger.info({ freeBalance }, 'Free balance');

  let orderQuantity = parseFloat(
    _.floor(freeBalance - freeBalance * (0.1 / 100), lotPrecision)
  );

  if (orderQuantity <= parseFloat(minQty)) {
    return setMessage(
      logger,
      data,
      `Order quantity is less or equal than the minimum quantity - ${minQty}. ` +
        `Do not place a stop-loss order.`
    );
  }

  if (orderQuantity > parseFloat(maxQty)) {
    orderQuantity = parseFloat(maxQty);
  }

  if (orderQuantity * currentPrice < parseFloat(minNotional)) {
    return setMessage(
      logger,
      data,
      `Notional value is less than the minimum notional value. ` +
        `Do not place a stop-loss order.`
    );
  }

  if (tradingEnabled !== true) {
    return setMessage(
      logger,
      data,
      `Trading for ${symbol} is disabled. Do not place a stop-loss order.`
    );
  }

  if (isExceedAPILimit(logger)) {
    return setMessage(
      logger,
      data,
      `Binance API limit has been exceeded. Do not place a stop-loss order.`
    );
  }

  // Currently, only support market order for stop-loss.
  const allowedOrderTypes = ['market'];
  if (allowedOrderTypes.includes(sellStopLossOrderType) === false) {
    return setMessage(
      logger,
      data,
      `Unknown order type ${sellStopLossOrderType}. Do not place a stop-loss order.`
    );
  }

  const orderParams = {
    symbol,
    side: 'sell',
    type: 'MARKET',
    quantity: orderQuantity
  };

  slack.sendMessage(
    `${symbol} Sell Stop-Loss Action (${moment().format(
      'HH:mm:ss.SSS'
    )}): *MARKET*` +
      `- Order Params: \`\`\`${JSON.stringify(
        orderParams,
        undefined,
        2
      )}\`\`\`\n` +
      `- Current API Usage: ${getAPILimit(logger)}`
  );

  logger.info(
    { function: 'order', orderParams, saveLog: true },
    'The market sell order will be placed.'
  );
  const orderResult = await binance.client.order(orderParams);

  logger.info(
    { orderResult, saveLog: true },
    'The market sell order has been placed.'
  );

  // Save stop loss to grid trade
  const newGridTrade = {
    buy: buyGridTrade,
    sell: sellGridTrade,
    stopLoss: orderResult
  };
  await saveSymbolGridTrade(logger, symbol, newGridTrade);

  // Temporary disable action
  if (canDisable) {
    await disableAction(
      logger,
      symbol,
      {
        disabledBy: 'stop loss',
        message: 'Temporary disabled by stop loss',
        canResume: true,
        canRemoveLastBuyPrice: true
      },
      sellStopLossDisableBuyMinutes * 60
    );
  }

  // Get open orders and update cache
  data.openOrders = await getAndCacheOpenOrdersForSymbol(logger, symbol);
  data.sell.openOrders = data.openOrders.filter(
    o => o.side.toLowerCase() === 'sell'
  );

  // Refresh account info
  data.accountInfo = await getAccountInfoFromAPI(logger);

  slack.sendMessage(
    `${symbol} Sell Stop-Loss Action Result (${moment().format(
      'HH:mm:ss.SSS'
    )}): *MARKET*\n` +
      `- Order Result: \`\`\`${JSON.stringify(
        orderResult,
        undefined,
        2
      )}\`\`\`\n` +
      `- Current API Usage: ${getAPILimit(logger)}`
  );

  return setMessage(logger, data, `Placed new market order for selling.`);
};

module.exports = { execute };
