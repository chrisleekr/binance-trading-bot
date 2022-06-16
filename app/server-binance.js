const _ = require('lodash');
// const moment = require('moment-timezone');
const config = require('config');
const { PubSub, binance, cache, mongo } = require('./helpers');

const { getAccountInfo } = require('./cronjob/trailingTradeHelper/common');
const { maskConfig } = require('./cronjob/trailingTradeHelper/util');

const { executeTrailingTrade } = require('./cronjob');

const {
  getGlobalConfiguration,
  getConfiguration
} = require('./cronjob/trailingTradeHelper/configuration');

const {
  getGridTradeLastOrder,
  updateGridTradeLastOrder,
  getManualOrder,
  saveManualOrder
} = require('./cronjob/trailingTradeHelper/order');

const {
  lockSymbol,
  unlockSymbol,
  getOpenOrdersFromAPI,
  getAndCacheOpenOrdersForSymbol,
  updateAccountInfo,
  getAccountInfoFromAPI,
  saveCandle,
  cacheExchangeSymbols
} = require('./cronjob/trailingTradeHelper/common');

let websocketCandlesClean = {};
let websocketATHCandlesClean = {};
let websocketTickersClean = {};
let userClean;

let exchangeSymbolsInterval;
let openOrdersInterval;

// let lastReceivedAt = moment();

const setupUserWebsocket = async logger => {
  if (userClean) {
    logger.info('Existing opened socket for user found, clean first');
    userClean();
  }

  userClean = await binance.client.ws.user(evt => {
    const { eventType } = evt;

    logger.info({ evt }, 'Received new user activity');

    if (['balanceUpdate', 'account'].includes(eventType)) {
      getAccountInfoFromAPI(logger);
    }

    if (eventType === 'outboundAccountPosition') {
      const { balances, lastAccountUpdate } = evt;
      updateAccountInfo(logger, balances, lastAccountUpdate);
    }

    if (eventType === 'executionReport') {
      const {
        eventTime,
        symbol,
        side,
        orderStatus,
        orderType,
        stopPrice,
        price,
        orderId,
        quantity,
        isOrderWorking,
        totalQuoteTradeQuantity,
        totalTradeQuantity
      } = evt;
      logger.info({ evt }, 'Received new report');

      const checkLastOrder = async () => {
        const lastOrder = await getGridTradeLastOrder(
          logger,
          symbol,
          side.toLowerCase()
        );

        if (_.isEmpty(lastOrder) === false) {
          await updateGridTradeLastOrder(logger, symbol, side.toLowerCase(), {
            ...lastOrder,
            status: orderStatus,
            type: orderType,
            side,
            stopPrice,
            price,
            origQty: quantity,
            cummulativeQuoteQty: totalQuoteTradeQuantity,
            executedQty: totalTradeQuantity,
            isWorking: isOrderWorking,
            updateTime: eventTime
          });
        }
      };

      checkLastOrder();

      const checkManualOrder = async () => {
        const manualOrder = await getManualOrder(logger, symbol, orderId);

        if (_.isEmpty(manualOrder) === false) {
          await saveManualOrder(logger, symbol, orderId, {
            ...manualOrder,
            status: orderStatus,
            type: orderType,
            side,
            stopPrice,
            price,
            origQty: quantity,
            cummulativeQuoteQty: totalQuoteTradeQuantity,
            executedQty: totalTradeQuantity,
            isWorking: isOrderWorking,
            updateTime: eventTime
          });
        }
      };

      checkManualOrder();

      getAndCacheOpenOrdersForSymbol(logger, symbol);
    }
  });
};

const setupTickersWebsocket = async (logger, symbols) => {
  const accountInfo = await getAccountInfo(logger);

  const cachedExchangeSymbols =
    JSON.parse(await cache.hget('trailing-trade-common', 'exchange-symbols')) ||
    {};

  const monitoringSymbols = _.cloneDeep(symbols);

  accountInfo.balances.reduce((acc, b) => {
    const symbol = `${b.asset}BTC`;
    // Make sure the symbol existing in Binance. Otherwise, just ignore.
    if (
      cachedExchangeSymbols[symbol] !== undefined &&
      acc.includes(symbol) === false
    ) {
      acc.push(symbol);
    }
    return acc;
  }, monitoringSymbols);

  // eslint-disable-next-line no-restricted-syntax
  for (const monitoringSymbol of monitoringSymbols) {
    if (monitoringSymbol in websocketTickersClean) {
      logger.info(
        `Existing opened stream for ${monitoringSymbol} ticker found, clean first`
      );
      websocketTickersClean[monitoringSymbol]();
    }

    websocketTickersClean[monitoringSymbol] =
      // eslint-disable-next-line no-await-in-loop
      await binance.client.ws.miniTicker(monitoringSymbol, ticker => {
        const { eventType, eventTime, curDayClose: close } = ticker;
        // logger.info({ ticker }, 'Received new ticker');

        // // Record last received date/time
        // lastReceivedAt = moment();

        // Save latest candle for the symbol
        cache.hset(
          'trailing-trade-symbols',
          `${ticker.symbol}-latest-candle`,
          JSON.stringify({
            eventType,
            eventTime,
            symbol: monitoringSymbol,
            close
          })
        );

        const canExecuteTrailingTrade = symbols.includes(monitoringSymbol);

        logger.info({ ticker, canExecuteTrailingTrade }, 'Received new ticker');

        if (canExecuteTrailingTrade) {
          executeTrailingTrade(logger, monitoringSymbol);
        }
      });
  }
};

const setupCandlesWebsocket = async (logger, symbols) => {
  _.forEach(symbols, symbol => {
    if (symbol in websocketCandlesClean) {
      logger.info(
        `Existing opened stream for ${symbol}'s candles found, clean first`
      );
      websocketCandlesClean[symbol]();
    }
  });

  const symbolsGroupedByIntervals = _.groupBy(symbols, async symbol => {
    const symbolConfiguration = await getConfiguration(logger, symbol);

    const {
      candles: { interval }
    } = symbolConfiguration;

    return interval;
  });

  _.forEach(symbolsGroupedByIntervals, async (symbolsGroup, candleInterval) => {
    // eslint-disable-next-line no-await-in-loop
    websocketCandlesClean[candleInterval] = await binance.client.ws.candles(
      symbolsGroup,
      candleInterval,
      candle => {
        saveCandle(logger, 'trailing-trade-candles', {
          key: candle.symbol,
          interval: candle.interval,
          time: +candle.startTime,
          open: +candle.open,
          high: +candle.high,
          low: +candle.low,
          close: +candle.close,
          volume: +candle.volume
        });
      }
    );
  });
};

const setupATHCandlesWebsocket = async (logger, symbols) => {
  const filteredATHSymbols = [];

  _.forEach(symbols, async symbol => {
    const symbolConfiguration = await getConfiguration(logger, symbol);

    const {
      buy: {
        athRestriction: { enabled: buyATHRestrictionEnabled }
      }
    } = symbolConfiguration;

    if (symbol in websocketATHCandlesClean) {
      logger.info(
        `Existing opened socket for ${symbol} candles found, clean first`
      );
      websocketATHCandlesClean[symbol]();
    }

    if (buyATHRestrictionEnabled) {
      filteredATHSymbols.push(symbol);
    }
  });

  const athSymbolsGroupedByIntervals = _.groupBy(
    filteredATHSymbols,
    async symbol => {
      const symbolConfiguration = await getConfiguration(logger, symbol);

      const {
        buy: {
          athRestriction: {
            candles: { interval: buyATHRestrictionCandlesInterval }
          }
        }
      } = symbolConfiguration;

      return buyATHRestrictionCandlesInterval;
    }
  );

  _.forEach(
    athSymbolsGroupedByIntervals,
    async (symbolsGroup, candleInterval) => {
      // eslint-disable-next-line no-await-in-loop
      websocketATHCandlesClean[candleInterval] =
        await binance.client.ws.candles(
          symbolsGroup,
          candleInterval,
          candle => {
            saveCandle(logger, 'trailing-trade-ath-candles', {
              key: candle.symbol,
              interval: candle.interval,
              time: +candle.startTime,
              open: +candle.open,
              high: +candle.high,
              low: +candle.low,
              close: +candle.close,
              volume: +candle.volume
            });
          }
        );
    }
  );
};

/**
 * Setup exchange symbols and store them in cache
 *
 * @param {*} logger
 */
const setupExchangeSymbols = async logger => {
  if (exchangeSymbolsInterval) {
    clearInterval(exchangeSymbolsInterval);
  }

  exchangeSymbolsInterval = setInterval(async () => {
    // Retrieve exchange symbols and cache it
    await cacheExchangeSymbols(logger);
  }, 60 * 1000);
};

/**
 * Setup websocket streams
 *
 * @param {*} logger
 * @param {*} symbols
 */
const setupWebsockets = async (logger, symbols) => {
  await setupUserWebsocket(logger);
  await setupCandlesWebsocket(logger, symbols);
  await setupATHCandlesWebsocket(logger, symbols);
  await setupTickersWebsocket(logger, symbols);

  await cache.hset(
    'trailing-trade-streams',
    'count',
    1 +
      _.size(websocketTickersClean) +
      _.size(websocketCandlesClean) +
      _.size(websocketATHCandlesClean)
  );
};

/**
 * Retrieve ATH candles for symbols from Binance API
 *
 * @param {*} logger
 * @param {string[]} symbols
 */
const syncCandles = async (logger, symbols) => {
  await Promise.all(
    symbols.map(async symbol => {
      await mongo.deleteAll(logger, 'trailing-trade-candles', {
        key: symbol
      });

      const symbolConfiguration = await getConfiguration(logger, symbol);

      const {
        candles: { interval, limit }
      } = symbolConfiguration;

      // Retrieve candles
      logger.info(
        { debug: true, function: 'candles', interval, limit },
        `Retrieving candles from API for ${symbol}`
      );

      const getCandles = async () => {
        const candles = await binance.client.candles({
          symbol,
          interval,
          limit
        });
        await Promise.all(
          candles.map(async candle =>
            saveCandle(logger, 'trailing-trade-candles', {
              key: symbol,
              interval,
              time: +candle.openTime,
              open: +candle.open,
              high: +candle.high,
              low: +candle.low,
              close: +candle.close,
              volume: +candle.volume
            })
          )
        );
      };

      return getCandles();
    })
  );
};

/**
 * Retrieve ATH candles for symbols from Binance API
 *
 * @param {*} logger
 * @param {string[]} symbols
 */
const syncATHCandles = async (logger, symbols) => {
  await Promise.all(
    symbols.map(async symbol => {
      await mongo.deleteAll(logger, 'trailing-trade-ath-candles', {
        key: symbol
      });
      const symbolConfiguration = await getConfiguration(logger, symbol);

      const {
        buy: {
          athRestriction: {
            enabled: buyATHRestrictionEnabled,
            candles: {
              interval: buyATHRestrictionCandlesInterval,
              limit: buyATHRestrictionCandlesLimit
            }
          }
        }
      } = symbolConfiguration;

      const getCandles = async () => {
        if (buyATHRestrictionEnabled) {
          // Retrieve ath candles
          logger.info(
            {
              debug: true,
              function: 'candles',
              interval: buyATHRestrictionCandlesInterval,
              limit: buyATHRestrictionCandlesLimit
            },
            `Retrieving ATH candles from API for ${symbol}`
          );
          const athCandles = await binance.client.candles({
            symbol,
            interval: buyATHRestrictionCandlesInterval,
            limit: buyATHRestrictionCandlesLimit
          });
          // Save ath candles for the symbol
          await Promise.all(
            athCandles.map(async athCandle =>
              saveCandle(logger, 'trailing-trade-ath-candles', {
                key: symbol,
                interval: buyATHRestrictionCandlesInterval,
                time: +athCandle.openTime,
                open: +athCandle.open,
                high: +athCandle.high,
                low: +athCandle.low,
                close: +athCandle.close,
                volume: +athCandle.volume
              })
            )
          );
        }
      };

      return getCandles();
    })
  );
};

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
  openOrdersInterval = setInterval(async () => {
    try {
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
    } catch (e) {
      logger.error(e, "Couldn't fetch open orders!");
    }
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

const refreshCandles = async logger => {
  if (_.isEmpty(websocketCandlesClean) === false) {
    logger.info('Existing opened socket for candles found, clean first');
    _.forEach(websocketCandlesClean, (clean, _key) => {
      clean();
    });
    websocketCandlesClean = {};
  }
  if (_.isEmpty(websocketATHCandlesClean) === false) {
    logger.info('Existing opened socket for candles found, clean first');
    _.forEach(websocketATHCandlesClean, (clean, _key) => {
      clean();
    });
    websocketATHCandlesClean = {};
  }
  if (_.isEmpty(websocketTickersClean) === false) {
    logger.info('Existing opened socket for tickers found, clean first');
    _.forEach(websocketTickersClean, (clean, _key) => {
      clean();
    });
    websocketTickersClean = {};
  }
  // empty all candles before restarting the bot
  await mongo.deleteAll(logger, 'trailing-trade-candles', {});
  await mongo.deleteAll(logger, 'trailing-trade-ath-candles', {});
};

/**
 * Setup web socket for retrieving candles
 *
 * @param {*} logger
 */
const syncAll = async logger => {
  logger.info('Start syncing the bot...');

  // reset candles and streams before restart to remove any unused symbol
  await refreshCandles(logger);

  // // Retrieve account info from API
  await getAccountInfoFromAPI(logger);

  // Get configuration
  const globalConfiguration = await getGlobalConfiguration(logger);

  // Retrieve list of monitoring symbols
  const { symbols } = globalConfiguration;

  logger.info({ symbols }, 'Retrieved symbols');

  // Lock all symbols for 5 minutes to ensure nothing will be executed unless all data retrieved
  await Promise.all(symbols.map(symbol => lockSymbol(logger, symbol, 300)));

  await setupExchangeSymbols(logger);
  await setupWebsockets(logger, symbols);

  await syncCandles(logger, symbols);
  await syncATHCandles(logger, symbols);
  await syncOpenOrders(logger, symbols);
  await syncDatabaseOrders(logger);

  // Unlock all symbols when all data has been retrieved
  await Promise.all(symbols.map(symbol => unlockSymbol(logger, symbol)));
};

/**
 * Setup retrieving latest candle from live server via Web Socket
 *
 * @param {*} logger
 */
const setupLive = async logger => {
  PubSub.subscribe('reset-all-websockets', async (message, data) => {
    logger.info(`Message: ${message}, Data: ${data}`);

    PubSub.publish('frontend-notification', {
      type: 'info',
      title: 'Restarting bot...'
    });

    await syncAll(logger);
  });
  PubSub.subscribe('reset-symbol-websockets', async (message, data) => {
    logger.info(`Message: ${message}, Data: ${data}`);

    const symbol = message;

    PubSub.publish('frontend-notification', {
      type: 'info',
      title: `Restarting ${symbol} websockets...`
    });

    await setupCandlesWebsocket(logger, [symbol]);
    await setupATHCandlesWebsocket(logger, [symbol]);
    await setupTickersWebsocket(logger, [symbol]);

    await syncCandles(logger, [symbol]);
    await syncATHCandles(logger, [symbol]);
  });

  await syncAll(logger);
};

// const loopToCheckLastReceivedAt = async logger => {
//   const currentTime = moment();
//
//   // If last received candle time is more than a minutes, then it means something went wrong. Reconnect websocket.
//   if (lastReceivedAt.diff(currentTime) / 1000 < -60) {
//     logger.warn(
//       'Binance candle is not received in last minutes. Reconfigure websocket'
//     );
//
//     if (config.get('featureToggle.notifyDebug')) {
//       slack.sendMessage(
//         `Binance Websocket (${moment().format(
//           'HH:mm:ss.SSS'
//         )}): The bot didn't receive new candle from Binance Websocket since ${lastReceivedAt.fromNow()}.` +
//           ` Reset Websocket connection.`
//       );
//     }
//
//     await syncAll(logger);
//   }
//
//   setTimeout(() => loopToCheckLastReceivedAt(logger), 1000);
// };

/**
 * Setup retrieving latest candle from test server via API
 *
 * @param {*} logger
 */
const setupTest = async logger => {
  // Get configuration
  const globalConfiguration = await getGlobalConfiguration(logger);

  // Retrieve list of monitoring symbols
  const { symbols } = globalConfiguration;

  logger.info({ symbols }, 'Retrieved symbols');

  const currentPrices = await binance.client.prices();

  _.forEach(currentPrices, (currentPrice, currentSymbol) => {
    if (symbols.includes(currentSymbol)) {
      logger.info({ currentSymbol, currentPrice }, 'Received new price');

      cache.hset(
        'trailing-trade-symbols',
        `${currentSymbol}-latest-candle`,
        JSON.stringify({
          eventType: 'kline',
          symbol: currentSymbol,
          close: currentPrice
        })
      );
    }
  });

  // It's impossible to test async function in the setTimeout.
  /* istanbul ignore next */
  setTimeout(() => setupTest(logger), 1000);
};

/**
 * Configure Binance Web Socket
 *
 *  Note that Binance Test Server Web Socket is not providing test server's candles.
 *  To avoid the issue with the test server, when the mode is test, it will use API call to retrieve current prices.
 *
 * @param {*} serverLogger
 */
const runBinance = async serverLogger => {
  const logger = serverLogger.child({ server: 'binance' });
  const mode = config.get('mode');

  logger.info(
    { config: maskConfig(config) },
    `Binance ${config.get('mode')} started on`
  );

  if (mode === 'live') {
    await setupLive(logger);
    // await loopToCheckLastReceivedAt(logger);
  } else {
    await setupTest(logger);
  }
};

module.exports = { runBinance };
