const _ = require('lodash');

const { cache } = require('../../helpers');
const {
  getGlobalConfiguration
} = require('../../jobs/trailingTrade/configuration');

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

  const configuration = await getGlobalConfiguration(logger);
  logger.info({ configuration }, 'Configuration from MongoDB');

  let common = {};
  try {
    common = {
      configuration,
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

  logger.info(
    {
      account: common.accountInfo,
      publicURL: common.publicURL,
      stats,
      configuration
    },
    'stats'
  );

  ws.send(
    JSON.stringify({
      result: true,
      type: 'latest',
      configuration,
      common,
      stats
    })
  );
};

module.exports = { handleLatest };
