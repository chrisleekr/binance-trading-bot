const _ = require('lodash');

const { version } = require('../../../../package.json');

const { binance, cache } = require('../../../helpers');
const {
  getGlobalConfiguration,
  getConfiguration
} = require('../../../cronjob/trailingTradeHelper/configuration');

const {
  getLastBuyPrice,
  isActionDisabled
} = require('../../../cronjob/trailingTradeHelper/common');

const getSymbolFromKey = key => {
  const fragments = key.split('-');
  const symbol = fragments[0];
  fragments.shift();
  return {
    symbol,
    newKey: fragments.join('-')
  };
};

const handleLatest = async (logger, ws, payload) => {
  const globalConfiguration = await getGlobalConfiguration(logger);
  logger.info({ globalConfiguration }, 'Configuration from MongoDB');

  // If not authenticated and lock list is enabled, then do not send any information.
  if (
    payload.isAuthenticated === false &&
    globalConfiguration.botOptions.authentication.lockList === true
  ) {
    ws.send(
      JSON.stringify({
        result: true,
        type: 'latest',
        isAuthenticated: payload.isAuthenticated,
        botOptions: globalConfiguration.botOptions,
        configuration: {},
        common: {},
        closedTradesSetting: {},
        closedTrades: [],
        stats: {}
      })
    );

    return;
  }

  const cacheTrailingTradeCommon = await cache.hgetall('trailing-trade-common');
  const cacheTrailingTradeSymbols = await cache.hgetall(
    'trailing-trade-symbols'
  );
  const cacheTrailingTradeClosedTrades = _.map(
    await cache.hgetall('trailing-trade-closed-trades'),
    stats => JSON.parse(stats)
  );

  const stats = {
    symbols: {}
  };

  let common = {};
  try {
    common = {
      version,
      gitHash: process.env.GIT_HASH || 'unspecified',
      accountInfo: JSON.parse(cacheTrailingTradeCommon['account-info']),
      exchangeSymbols: JSON.parse(cacheTrailingTradeCommon['exchange-symbols']),
      publicURL: cacheTrailingTradeCommon['local-tunnel-url'],
      apiInfo: binance.client.getInfo(),
      closedTradesSetting: JSON.parse(
        cacheTrailingTradeCommon['closed-trades']
      ),
      closedTrades: cacheTrailingTradeClosedTrades
    };
  } catch (e) {
    logger.error({ e }, 'Something wrong with trailing-trade-common cache');

    return;
  }

  _.forIn(cacheTrailingTradeSymbols, (value, key) => {
    const { symbol, newKey } = getSymbolFromKey(key);

    if (newKey === 'data') {
      stats.symbols[symbol] = JSON.parse(value);
    }
  });

  stats.symbols = await Promise.all(
    _.map(stats.symbols, async symbol => {
      const newSymbol = symbol;
      // Retrieve latest symbol configuration
      newSymbol.symbolConfiguration = await getConfiguration(
        logger,
        newSymbol.symbol
      );

      // Retrieve latest last buy price
      const lastBuyPriceDoc = await getLastBuyPrice(logger, newSymbol.symbol);
      const lastBuyPrice = _.get(lastBuyPriceDoc, 'lastBuyPrice', null);
      newSymbol.sell.lastBuyPrice = lastBuyPrice;

      // Retreive action disabled
      newSymbol.isActionDisabled = await isActionDisabled(newSymbol.symbol);
      return newSymbol;
    })
  );

  logger.info(
    {
      account: common.accountInfo,
      publicURL: common.publicURL,
      stats,
      configuration: globalConfiguration
    },
    'stats'
  );

  ws.send(
    JSON.stringify({
      result: true,
      type: 'latest',
      isAuthenticated: payload.isAuthenticated,
      botOptions: globalConfiguration.botOptions,
      configuration: globalConfiguration,
      common,
      stats
    })
  );
};

module.exports = { handleLatest };
