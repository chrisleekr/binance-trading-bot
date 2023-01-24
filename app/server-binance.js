const _ = require('lodash');
const config = require('config');
const { PubSub, cache, mongo } = require('./helpers');
const queue = require('./cronjob/trailingTradeHelper/queue');
const { executeTrailingTrade } = require('./cronjob/index');

const { maskConfig } = require('./cronjob/trailingTradeHelper/util');
const {
  getGlobalConfiguration
} = require('./cronjob/trailingTradeHelper/configuration');
const {
  getAccountInfoFromAPI,
  cacheExchangeSymbols
} = require('./cronjob/trailingTradeHelper/common');
const {
  getWebsocketATHCandlesClean,
  setupATHCandlesWebsocket,
  syncATHCandles
} = require('./binance/ath-candles');
const {
  getWebsocketCandlesClean,
  setupCandlesWebsocket,
  syncCandles
} = require('./binance/candles');
const {
  getWebsocketTickersClean,
  refreshTickersClean,
  setupTickersWebsocket
} = require('./binance/tickers');
const { syncOpenOrders, syncDatabaseOrders } = require('./binance/orders');
const { setupUserWebsocket } = require('./binance/user');

let exchangeSymbolsInterval;

/**
 * Setup websocket streams
 *
 * @param {*} logger
 * @param {*} symbols
 */
const setupWebsockets = async (logger, symbols) => {
  await Promise.all([
    setupUserWebsocket(logger),
    setupCandlesWebsocket(logger, symbols),
    setupATHCandlesWebsocket(logger, symbols),
    setupTickersWebsocket(logger, symbols)
  ]);

  await cache.hset(
    'trailing-trade-streams',
    'count',
    1 +
      _.size(getWebsocketTickersClean()) +
      _.size(getWebsocketCandlesClean()) +
      _.size(getWebsocketATHCandlesClean())
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

  // Retrieve exchange symbols and cache it
  await cacheExchangeSymbols(logger);

  exchangeSymbolsInterval = setInterval(async () => {
    // Retrieve exchange symbols and cache it
    await cacheExchangeSymbols(logger);
  }, 60 * 1000);
};

const refreshCandles = async logger => {
  refreshTickersClean(logger);

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

  // Retrieve account info from API
  await getAccountInfoFromAPI(logger);

  // Get configuration
  const globalConfiguration = await getGlobalConfiguration(logger);

  // Retrieve list of monitoring symbols
  const { symbols } = globalConfiguration;

  logger.info({ symbols }, 'Retrieved symbols');

  // Start job for all symbols to ensure nothing will be executed unless all data retrieved
  await Promise.all(symbols.map(symbol => queue.prepareJob(logger, symbol)));

  await setupExchangeSymbols(logger);
  await setupWebsockets(logger, symbols);

  await syncCandles(logger, symbols);
  await syncATHCandles(logger, symbols);
  await syncOpenOrders(logger, symbols);
  await syncDatabaseOrders(logger);

  // Complete job for all symbols when all data has been retrieved
  await Promise.all(symbols.map(symbol => queue.completeJob(logger, symbol)));
};

/**
 * Setup retrieving latest candle from live server via Web Socket
 *
 * @param {*} logger
 */
const setupBinance = async logger => {
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

    const symbol = data;

    PubSub.publish('frontend-notification', {
      type: 'info',
      title: `Restarting ${symbol} websockets...`
    });

    // Get configuration
    const globalConfiguration = await getGlobalConfiguration(logger);

    // Retrieve list of monitoring symbols
    const { symbols } = globalConfiguration;

    // Candles & ATH candles should receive all monitoring symbols to create their connection from scratch
    // because they are grouped by symbols intervals and not by their names
    await Promise.all([
      setupCandlesWebsocket(logger, symbols),
      setupATHCandlesWebsocket(logger, symbols),
      setupTickersWebsocket(logger, [symbol])
    ]);

    await syncCandles(logger, [symbol]);
    await syncATHCandles(logger, [symbol]);
  });
  PubSub.subscribe('check-open-orders', async (message, data) => {
    logger.info(`Message: ${message}, Data: ${data}`);

    const cachedOpenOrders = await cache.hgetall(
      'trailing-trade-open-orders:',
      'trailing-trade-open-orders:*'
    );

    const symbols = _.keys(cachedOpenOrders);

    await Promise.all(
      symbols.map(async symbol =>
        queue.execute(logger, symbol, { processFn: executeTrailingTrade })
      )
    );
  });

  await syncAll(logger);
};

/**
 * Configure Binance Web Socket
 *
 * @param {*} serverLogger
 */
const runBinance = async serverLogger => {
  const logger = serverLogger.child({ server: 'binance' });

  logger.info(
    { config: maskConfig(config) },
    `Binance ${config.get('mode')} started on`
  );

  await setupBinance(logger);
};

module.exports = { runBinance };
