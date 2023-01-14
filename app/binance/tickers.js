const { v4: uuidv4 } = require('uuid');
const _ = require('lodash');
const { binance, cache } = require('../helpers');
const queue = require('../cronjob/trailingTradeHelper/queue');
const { executeTrailingTrade } = require('../cronjob/index');

const {
  getAccountInfo,
  getCachedExchangeSymbols
} = require('../cronjob/trailingTradeHelper/common');
const { errorHandlerWrapper } = require('../error-handler');

let websocketTickersClean = {};

const setupTickersWebsocket = async (logger, symbols) => {
  const accountInfo = await getAccountInfo(logger);

  const cachedExchangeSymbols = await getCachedExchangeSymbols(logger);

  const monitoringSymbols = _.cloneDeep(symbols);

  // we are adding ${symbol}BTC to our monitoring symbols to support
  // dust transfer feature, and we will not use them for anything else
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

    websocketTickersClean[monitoringSymbol] = binance.client.ws.miniTicker(
      monitoringSymbol,
      ticker => {
        errorHandlerWrapper(logger, 'Tickers', async () => {
          const correlationId = uuidv4();

          const { eventType, eventTime, curDayClose: close, symbol } = ticker;

          const symbolLogger = logger.child({
            correlationId,
            symbol
          });

          const saveCandle = async () => {
            // Save latest candle for the symbol
            await cache.hset(
              'trailing-trade-symbols',
              `${symbol}-latest-candle`,
              JSON.stringify({
                eventType,
                eventTime,
                symbol,
                close
              })
            );
          };

          const canExecuteTrailingTrade = symbols.includes(monitoringSymbol);

          symbolLogger.info(
            { ticker, canExecuteTrailingTrade },
            'Received new ticker'
          );

          if (canExecuteTrailingTrade) {
            queue.execute(symbolLogger, monitoringSymbol, {
              correlationId,
              preprocessFn: saveCandle,
              processFn: executeTrailingTrade
            });
          } else {
            saveCandle();
          }
        });
      }
    );
  }
};

const getWebsocketTickersClean = () => websocketTickersClean;

const refreshTickersClean = logger => {
  if (_.isEmpty(websocketTickersClean) === false) {
    logger.info('Existing opened socket for tickers found, clean first');
    _.forEach(websocketTickersClean, (clean, _key) => {
      clean();
    });
    websocketTickersClean = {};
  }
};

module.exports = {
  setupTickersWebsocket,
  getWebsocketTickersClean,
  refreshTickersClean
};
