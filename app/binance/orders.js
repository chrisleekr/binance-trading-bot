const _ = require('lodash');
const { binance, cache, mongo } = require('../helpers');
const {
  getOpenOrdersFromAPI
} = require('../cronjob/trailingTradeHelper/common');
const {
  updateGridTradeLastOrder
} = require('../cronjob/trailingTradeHelper/order');
const { errorHandlerWrapper } = require('../error-handler');

let openOrdersInterval;

/**
 * Retrieve open orders every x seconds
 * This is just to recover open orders when an order was missed by a mistake
 *
 * @param {*} logger
 * @param symbols
 */
const syncOpenOrders = async (logger, symbols) => {
  if (openOrdersInterval) {
    clearInterval(openOrdersInterval);
  }

  // We do 40 seconds interval in case one of the orders missed from the websockets
  openOrdersInterval = setInterval(() => {
    errorHandlerWrapper(logger, 'Orders', async () => {
      const openOrders = await getOpenOrdersFromAPI(logger);

      const initializedSymbolOpenOrders = _.reduce(
        symbols,
        (obj, symbol) => {
          // eslint-disable-next-line no-param-reassign
          obj[symbol] = [];
          return obj;
        },
        {}
      );

      const symbolOpenOrders = _.groupBy(openOrders, 'symbol');

      const mergedOpenOrders = _.merge(
        initializedSymbolOpenOrders,
        symbolOpenOrders
      );

      await Promise.all(
        _.map(mergedOpenOrders, (orders, symbol) =>
          cache.hset(
            'trailing-trade-open-orders',
            symbol,
            JSON.stringify(orders)
          )
        )
      );
    });
  }, 30 * 1310);
};

/**
 * Sync database orders on boot with binance by orderId
 * This is helpful when the order executed and the bot is not on
 *
 * @param {*} logger
 */
const syncDatabaseOrders = async logger => {
  const databaseOrders = await mongo.findAll(
    logger,
    'trailing-trade-grid-trade-orders',
    {}
  );

  await Promise.all(
    databaseOrders.map(async databaseOrder => {
      const { order } = databaseOrder;
      const { symbol, orderId } = order;

      const orderResult = await binance.client.getOrder({
        symbol,
        orderId
      });

      const { side } = orderResult;

      return updateGridTradeLastOrder(logger, symbol, side.toLowerCase(), {
        ...order,
        ...orderResult
      });
    })
  );
};

module.exports = { syncOpenOrders, syncDatabaseOrders };
