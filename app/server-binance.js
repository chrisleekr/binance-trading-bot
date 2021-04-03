const config = require('config');
const { PubSub, binance, cache } = require('./helpers');

const {
  getGlobalConfiguration
} = require('./cronjob/trailingTradeHelper/configuration');

let websocketCandlesClean;

/**
 * Setup web socket for retrieving candles
 *
 * @param {*} logger
 */
const setWebSocketCandles = async logger => {
  logger.info('Set websocket for candles');

  // Get configuration
  const globalConfiguration = await getGlobalConfiguration(logger);

  const { symbols } = globalConfiguration;
  logger.info({ symbols }, 'Retrieved symbols');

  if (websocketCandlesClean) {
    logger.info('Existing opened socket for candles found, clean first');
    websocketCandlesClean();
  }
  websocketCandlesClean = binance.client.ws.candles(symbols, '1m', candle => {
    logger.info({ candle }, 'Received new candle');

    cache.hset(
      'trailing-trade-symbols',
      `${candle.symbol}-latest-candle`,
      JSON.stringify(candle)
    );
  });
};

const runBinance = async serverLogger => {
  const logger = serverLogger.child({ server: 'binance' });
  logger.info({ config }, `Binance ${config.get('mode')} started on`);

  PubSub.subscribe(
    'trailing-trade-configuration-changed',
    async (message, data) => {
      logger.info(`Message: ${message}, Data: ${data}`);
      await setWebSocketCandles(logger);
    }
  );

  await setWebSocketCandles(logger);
};

module.exports = { runBinance };
