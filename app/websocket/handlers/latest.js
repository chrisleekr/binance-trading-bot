const _ = require('lodash');

const { cache } = require('../../helpers');
const {
  getGlobalConfiguration,
  getConfiguration
} = require('../../jobs/trailingTrade/configuration');

const { getLastBuyPrice } = require('../../jobs/trailingTrade/symbol');

const getSymbolFromKey = key => {
  const fragments = key.split('-');
  const symbol = fragments[0];
  fragments.shift();
  return {
    symbol,
    newKey: fragments.join('-')
  };
};

const handleLatest = async (logger, ws, _payload) => {
  const cacheTrailingTradeCommon = await cache.hgetall('trailing-trade-common');
  const cacheTrailingTradeSymbols = await cache.hgetall(
    'trailing-trade-symbols'
  );
  logger.info(
    { cacheTrailingTradeCommon, cacheTrailingTradeSymbols },
    'cached values'
  );

  const stats = {
    symbols: {}
  };

  const globalConfiguration = await getGlobalConfiguration(logger);
  logger.info({ globalConfiguration }, 'Configuration from MongoDB');

  let common = {};
  try {
    common = {
      configuration: globalConfiguration,
      accountInfo: JSON.parse(cacheTrailingTradeCommon['account-info']),
      exchangeSymbols: JSON.parse(cacheTrailingTradeCommon['exchange-symbols']),
      publicURL: cacheTrailingTradeCommon['local-tunnel-url']
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
      // Set latest global configuration
      newSymbol.globalConfiguration = globalConfiguration;
      // Retrieve latest symbol configuration
      newSymbol.symbolConfiguration = await getConfiguration(
        logger,
        newSymbol.symbol
      );
      // Retrieve latest last buy price
      newSymbol.sell.lastBuyPrice = await getLastBuyPrice(
        logger,
        newSymbol.symbol
      );
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
      configuration: globalConfiguration,
      common,
      stats
    })
  );
};

module.exports = { handleLatest };
