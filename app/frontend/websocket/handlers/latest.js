const _ = require('lodash');
const config = require('config');
const { version } = require('../../../../package.json');

const { binance, cache, messenger } = require('../../../helpers');
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

const timeDiffCalc = async (dateFuture, dateNow) => {
  let diffInMilliSeconds = Math.abs(dateFuture - dateNow) / 1000;

  // calculate minutes
  const minutes = Math.floor(diffInMilliSeconds / 60) % 60;
  diffInMilliSeconds -= minutes * 60;

  return minutes;
}

const handleLatest = async (logger, ws, _payload) => {
  const cacheTrailingTradeCommon = await cache.hgetall('trailing-trade-common');
  const cacheTrailingTradeSymbols = await cache.hgetall(
    'trailing-trade-symbols'
  );

  const stats = {
    symbols: {}
  };

  const globalConfiguration = await getGlobalConfiguration(logger);
  logger.info({ globalConfiguration }, 'Configuration from MongoDB');

  const savedPassword = config.get('password');

  if (savedPassword != '' || savedPassword != undefined) {
    globalConfiguration.botOptions.login.passwordActivated = true;
  } else {
    globalConfiguration.botOptions.login.passwordActivated = false;
  }

  const cachedTempLogin =
    JSON.parse(await cache.get(`tempLogin`)) || {};

  if (timeDiffCalc(new Date(), cachedTempLogin.elapsedTime) > cachedTempLogin.loginWindowMinutes) {
    await cache.del(`tempLogin`);
  }

  let common = {};
  try {
    if (globalConfiguration.language != config.get('language')) {
      globalConfiguration.language = config.get('language')
    }
    common = {
      version,
      gitHash: process.env.GIT_HASH || 'unspecified',
      configuration: globalConfiguration,
      accountInfo: JSON.parse(cacheTrailingTradeCommon['account-info']),
      exchangeSymbols: JSON.parse(cacheTrailingTradeCommon['exchange-symbols']),
      publicURL: cacheTrailingTradeCommon['local-tunnel-url'],
      apiInfo: binance.client.getInfo(),
      passwordActivated: globalConfiguration.botOptions.login.passwordActivated,
      login: cachedTempLogin
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
      configuration: globalConfiguration,
      common,
      stats
    })
  );
};

module.exports = { handleLatest };
