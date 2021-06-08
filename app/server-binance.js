const _ = require('lodash');
const moment = require('moment-timezone');
const config = require('config');
const { PubSub, binance, cache, slack } = require('./helpers');

const { getAccountInfo } = require('./cronjob/trailingTradeHelper/common');

const {
  getGlobalConfiguration
} = require('./cronjob/trailingTradeHelper/configuration');

let websocketCandlesClean;

let lastReceivedAt = moment();

/**
 * Retrieve the list of symbols to watch
 *  - This includes account's symbol to BTC pairs.
 *
 * @param {*} _logger
 * @param {*} param1
 * @returns
 */
const monitoringSymbols = async (
  _logger,
  { globalConfiguration, accountInfo }
) => {
  const { symbols: globalSymbols } = globalConfiguration;
  // To cut the reference for the global configuration symbols
  const symbols = _.cloneDeep(globalSymbols);

  const cachedExchangeSymbols =
    JSON.parse(await cache.hget('trailing-trade-common', 'exchange-symbols')) ||
    {};

  return accountInfo.balances.reduce((acc, b) => {
    const symbol = `${b.asset}BTC`;
    // Make sure the symbol existing in Binance. Otherwise, just ignore.
    if (
      cachedExchangeSymbols[symbol] !== undefined &&
      acc.includes(symbol) === false
    ) {
      acc.push(symbol);
    }
    return acc;
  }, symbols);
};

/**
 * Setup web socket for retrieving candles
 *
 * @param {*} logger
 */
const setWebSocketCandles = async logger => {
  logger.info('Set websocket for candles');

  // Get configuration
  const globalConfiguration = await getGlobalConfiguration(logger);

  // Retrieve account info from cache
  const accountInfo = await getAccountInfo(logger);

  // Retrieve list of monitoring symbols including assets BTC pairs
  const symbols = await monitoringSymbols(logger, {
    globalConfiguration,
    accountInfo
  });

  logger.info({ symbols }, 'Retrieved symbols');

  if (websocketCandlesClean) {
    logger.info('Existing opened socket for candles found, clean first');
    websocketCandlesClean();
  }
  websocketCandlesClean = binance.client.ws.candles(symbols, '1m', candle => {
    logger.info({ candle }, 'Received new candle');

    // Record last received date/time
    lastReceivedAt = moment();

    // Save latest candle for the symbol
    cache.hset(
      'trailing-trade-symbols',
      `${candle.symbol}-latest-candle`,
      JSON.stringify(candle)
    );
  });
};

/**
 * Setup retrieving latest candle from live server via Web Socket
 *
 * @param {*} logger
 */
const setupLive = async logger => {
  PubSub.subscribe('reset-binance-websocket', async (message, data) => {
    logger.info(`Message: ${message}, Data: ${data}`);
    await setWebSocketCandles(logger);
  });

  await setWebSocketCandles(logger);
};

const loopToCheckLastReceivedAt = async logger => {
  const currentTime = moment();

  // If last received candle time is more than a mintues, then it means something went wrong. Reconnect websocket.
  if (lastReceivedAt.diff(currentTime) / 1000 < -60) {
    logger.warn(
      { debug: true },
      'Binance candle is not received in last mintues. Reconfigure websocket'
    );

    if (config.get('featureToggle.notifyDebug')) {
      slack.sendMessage(
        `Binance Websocket (${moment().format(
          'HH:mm:ss.SSS'
        )}): The bot didn't receive new candle from Binance Websocket since ${lastReceivedAt.fromNow()}.` +
          ` Reset Websocket connection.`
      );
    }

    await setupLive(logger);
  }

  setTimeout(() => loopToCheckLastReceivedAt(logger), 1000);
};

/**
 * Setup retrieving latest candle from test server via API
 *
 * @param {*} logger
 */
const setupTest = async logger => {
  // Get configuration
  const globalConfiguration = await getGlobalConfiguration(logger);

  // Retrieve account info from cache
  const accountInfo = await getAccountInfo(logger);

  // Retrieve list of monitoring symbols including assets BTC pairs
  const symbols = await monitoringSymbols(logger, {
    globalConfiguration,
    accountInfo
  });

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

  logger.info({ config }, `Binance ${config.get('mode')} started on`);

  if (mode === 'live') {
    await setupLive(logger);
    await loopToCheckLastReceivedAt(logger);
  } else {
    await setupTest(logger);
  }
};

module.exports = { runBinance };
