const _ = require('lodash');
const { binance, cache } = require('../helpers');
const { getAccountInfo } = require('../cronjob/trailingTradeHelper/common');
const { executeTrailingTrade } = require('../cronjob');

let websocketTickersClean = {};

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
      binance.client.ws.miniTicker(monitoringSymbol, ticker => {
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
