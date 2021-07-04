const moment = require('moment');
const { binance, cache, PubSub, messenger } = require('../../../helpers');
const config = require('config');
const {
  getAPILimit,
  getAndCacheOpenOrdersForSymbol,
  getAccountInfoFromAPI
} = require('../../trailingTradeHelper/common');
/**
 * Format order params for market total
 *
 * @param {*} logger
 * @param {*} side
 * @param {*} symbol
 * @param {*} orderParams
 * @returns
 */
const formatOrderMarketTotal = async (logger, side, symbol, orderParams) => {
  logger.info(
    { side, symbol, orderParams },
    'Formatting order for MARKET-TOTAL'
  );

  return {
    symbol,
    side,
    type: 'MARKET',
    quoteOrderQty: orderParams.quoteOrderQty
  };
};

/**
 * Format order params for market amount
 *
 * @param {*} logger
 * @param {*} side
 * @param {*} symbol
 * @param {*} orderParams
 * @returns
 */
const formatOrderMarketAmount = async (logger, side, symbol, orderParams) => {
  logger.info(
    { side, symbol, orderParams },
    'Formatting order for MARKET-AMOUNT'
  );

  return {
    symbol,
    side,
    type: 'MARKET',
    quantity: orderParams.marketQuantity
  };
};

/**
 * Format order params for limit order
 *
 * @param {*} logger
 * @param {*} side
 * @param {*} symbol
 * @param {*} orderParams
 * @returns
 */
const formatOrderLimit = async (logger, side, symbol, orderParams) => {
  logger.info({ side, symbol, orderParams }, 'Formatting order for LIMIT');
  return {
    symbol,
    side,
    type: 'LIMIT',
    quantity: orderParams.quantity,
    price: orderParams.price
  };
};

/**
 * Formatting order params based on side and type/marketType
 *
 * @param {*} logger
 * @param {*} symbol
 * @param {*} order
 * @returns
 */
const formatOrder = async (logger, symbol, order) => {
  const { side, buy, sell } = order;

  if (side === 'buy' && buy.type === 'limit') {
    return formatOrderLimit(logger, side, symbol, buy);
  }

  if (side === 'buy' && buy.type === 'market' && buy.marketType === 'total') {
    return formatOrderMarketTotal(logger, side, symbol, buy);
  }

  if (side === 'buy' && buy.type === 'market' && buy.marketType === 'amount') {
    return formatOrderMarketAmount(logger, side, symbol, buy);
  }

  if (side === 'sell' && sell.type === 'limit') {
    return formatOrderLimit(logger, side, symbol, sell);
  }

  if (
    side === 'sell' &&
    sell.type === 'market' &&
    sell.marketType === 'total'
  ) {
    return formatOrderMarketTotal(logger, side, symbol, sell);
  }

  if (
    side === 'sell' &&
    sell.type === 'market' &&
    sell.marketType === 'amount'
  ) {
    return formatOrderMarketAmount(logger, side, symbol, sell);
  }

  throw new Error('Unknown order side/type for manual trade');
};

/**
 * Send slack message for order params
 *
 * @param {*} logger
 * @param {*} symbol
 * @param {*} side
 * @param {*} order
 * @param {*} params
 */
const messengerMessageOrderParams = async (
  logger,
  symbol,
  side,
  order,
  params
) => {
  const { type: rawType, marketType } = order[side];
  let type = rawType.toUpperCase();

  if (type === 'MARKET') {
    type += ` - ${marketType.toUpperCase()}`;
  }

  return messenger.errorMessage(
    `${symbol} Manual ${side.toUpperCase()} Action (${moment().format(
      'HH:mm:ss.SSS'
    )}): *${type}*\n` +
    `- Order Params: \`\`\`${JSON.stringify(params, undefined, 2)}\`\`\`\n` +
    `- Current API Usage: ${getAPILimit(logger)}`
  );
};

/**
 * Send slack message for order result
 *
 * @param {*} logger
 * @param {*} symbol
 * @param {*} side
 * @param {*} order
 * @param {*} orderResult
 */
const slackMessageOrderResult = async (
  logger,
  symbol,
  side,
  order,
  orderResult,
  actions
) => {
  const { type: rawType, marketType } = order[side];
  let type = rawType.toUpperCase();

  if (type === 'MARKET') {
    type += ` - ${marketType.toUpperCase()}`;
  }

  PubSub.publish('frontend-notification', {
    type: 'success',
    title:
      actions.notify_order_success[1] + side + actions.notify_order_success[2] + symbol + actions.notify_order_success[3]
  });

  return messenger.errorMessage(
    `${symbol} Manual ${side.toUpperCase()} Result (${moment().format(
      'HH:mm:ss.SSS'
    )}): *${type}*\n` +
    `- Order Result: \`\`\`${JSON.stringify(
      orderResult,
      undefined,
      2
    )}\`\`\`\n` +
    `- Current API Usage: ${getAPILimit(logger)}`
  );
};

/**
 * Record order for monitoring
 *
 * @param {*} logger
 * @param {*} orderResult
 * @param {*} checkManualBuyOrderPeriod
 */
const recordOrder = async (logger, orderResult, checkManualBuyOrderPeriod) => {
  const { symbol, side, orderId } = orderResult;

  if (side === 'BUY') {
    // Save manual buy order
    logger.info({ orderResult }, 'Record buy order');
    await cache.hset(
      `trailing-trade-manual-buy-order-${symbol}`,
      orderId,
      JSON.stringify({
        ...orderResult,
        nextCheck: moment().add(checkManualBuyOrderPeriod, 'seconds')
      })
    );
  } else {
    logger.info({ orderResult }, 'Do not record order as it is not BUY order');
  }
};

/**
 * Place a manual order
 *
 * @param {*} logger
 * @param {*} rawData
 */
const execute = async (logger, rawData) => {
  const data = rawData;
  const {
    symbol,
    isLocked,
    action,
    baseAssetBalance,
    symbolConfiguration: {
      system: { checkManualBuyOrderPeriod }
    },
    order
  } = data;

  if (isLocked) {
    logger.info({ isLocked }, 'Symbol is locked, do not process manual-trade');
    return data;
  }

  if (action !== 'manual-trade') {
    logger.info(
      `Do not process a manual order because action is not 'manual-trade'.`
    );
    return data;
  }
  const language = config.get('language');

  const { coin_wrapper: { _actions }, place_manual_trade } = require(`../../../../public/${config.get('language')}.json`);

  // Assume order is provided with correct value
  const orderParams = await formatOrder(logger, symbol, order);
  messengerMessageOrderParams(logger, symbol, order.side, order, orderParams);

  const orderResult = await binance.client.order(orderParams);

  logger.info({ orderResult }, 'Order result');

  await recordOrder(logger, orderResult, checkManualBuyOrderPeriod);

  // Get open orders and update cache
  data.openOrders = await getAndCacheOpenOrdersForSymbol(logger, symbol);
  data.buy.openOrders = data.openOrders.filter(
    o => o.side.toLowerCase() === 'buy'
  );
  data.sell.openOrders = data.openOrders.filter(
    o => o.side.toLowerCase() === 'sell'
  );
  // Refresh account info
  data.accountInfo = await getAccountInfoFromAPI(logger);

  slackMessageOrderResult(logger, symbol, order.side, order, orderResult, actions);
  data.buy.processMessage = place_manual_trade.action_manual_order;
  data.buy.updatedAt = moment().utc();

  return data;
};

module.exports = { execute };
