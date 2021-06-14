const _ = require('lodash');
const { cache, binance, mongo } = require('../../helpers');

const isValidCachedExchangeSymbols = exchangeSymbols =>
  _.get(
    exchangeSymbols,
    [Object.keys(exchangeSymbols)[0], 'minNotional'],
    null
  ) !== null;

/**
 * Retreive cached exhcnage symbols.
 *  If not cached, retrieve exchange info from API and cache it.
 *
 * @param {*} logger
 * @param {*} globalConfiguration
 */
const cacheExchangeSymbols = async (logger, _globalConfiguration) => {
  const cachedExchangeSymbols =
    JSON.parse(await cache.hget('trailing-trade-common', 'exchange-symbols')) ||
    {};
  // If there is already cached exchange symbols, don't need to cache again.
  if (
    _.isEmpty(cachedExchangeSymbols) === false &&
    // For backward compatibility, verify the cached value is valid.
    isValidCachedExchangeSymbols(cachedExchangeSymbols) === true
  ) {
    return;
  }

  // Retrieve cached exchange information
  const cachedExchangeInfo =
    JSON.parse(await cache.hget('trailing-trade-common', 'exchange-info')) ||
    {};

  let exchangeInfo = cachedExchangeInfo;
  if (_.isEmpty(cachedExchangeInfo) === true) {
    logger.info(
      { function: 'exchangeInfo' },
      'Retrieving exchange info from API'
    );
    exchangeInfo = await binance.client.exchangeInfo();
    await cache.hset(
      'trailing-trade-common',
      'exchange-info',
      JSON.stringify(exchangeInfo)
    );
  }

  logger.info('Retrieved exchange info from API');

  const { symbols } = exchangeInfo;

  const exchangeSymbols = symbols.reduce((acc, symbol) => {
    const minNotionalFilter = _.find(symbol.filters, {
      filterType: 'MIN_NOTIONAL'
    });
    acc[symbol.symbol] = {
      symbol: symbol.symbol,
      quoteAsset: symbol.quoteAsset,
      minNotional: parseFloat(minNotionalFilter.minNotional)
    };

    return acc;
  }, {});

  await cache.hset(
    'trailing-trade-common',
    'exchange-symbols',
    JSON.stringify(exchangeSymbols)
  );

  logger.info({ exchangeSymbols }, 'Saved exchange symbols to cache');
};

/**
 * Add estimatedBTC and canDustTransfer flags to balances
 *  - Leave this function for future reference
 *
 * @param {*} logger
 * @param {*} accountInfo
 * @returns
 */
const extendBalancesWithDustTransfer = async (_logger, rawAccountInfo) => {
  const accountInfo = rawAccountInfo;
  const ignoreAssets = ['BNB', 'BTC'];

  const newBalances = await Promise.all(
    accountInfo.balances.map(async b => {
      const balance = b;
      const symbol = `${b.asset}BTC`;

      // Set default value
      balance.estimatedBTC = -1;
      balance.canDustTransfer = false;

      // If asset can be ignored
      if (ignoreAssets.includes(balance.asset)) {
        return balance;
      }

      // Get latest candle for asset+BTC pair
      const cachedLatestCandle =
        JSON.parse(
          await cache.hget('trailing-trade-symbols', `${symbol}-latest-candle`)
        ) || {};

      // If cannot find the latest candle, assume not be able to do dust transfer
      if (_.isEmpty(cachedLatestCandle)) {
        return balance;
      }

      // https://academy.binance.com/en/articles/converting-dust-on-binance
      // In order to qualify the dust must have a value less than 0.0003BTC

      balance.estimatedBTC = Number(
        parseFloat(cachedLatestCandle.close) * parseFloat(balance.free)
      ).toFixed(8);

      // If the estimated BTC is less than 0.0003, then set dust transfer
      if (balance.estimatedBTC <= 0.0003) {
        balance.canDustTransfer = true;
      }

      return balance;
    })
  );

  accountInfo.balances = newBalances;
  return accountInfo;
};

/**
 * Retrieve account information from API and filter balances
 *
 * @param {*} logger
 */
const getAccountInfoFromAPI = async logger => {
  logger.info({ tag: 'get-account-info' }, 'Retrieving account info from API');
  const accountInfo = await binance.client.accountInfo();

  accountInfo.balances = accountInfo.balances.reduce((acc, b) => {
    const balance = b;
    if (+balance.free > 0 || +balance.locked > 0) {
      acc.push(balance);
    }

    return acc;
  }, []);

  logger.info(
    { tag: 'get-account-info', accountInfo },
    'Retrieved account information from API'
  );

  await cache.hset(
    'trailing-trade-common',
    'account-info',
    JSON.stringify(accountInfo)
  );

  return accountInfo;
};

/**
 * Retreive account info from cache
 *  If empty, retrieve from API
 *
 * @param {*} logger
 */
const getAccountInfo = async logger => {
  const accountInfo =
    JSON.parse(
      await cache.hgetWithoutLock('trailing-trade-common', 'account-info')
    ) || {};

  if (_.isEmpty(accountInfo) === false) {
    logger.info(
      { tag: 'get-account-info', accountInfo },
      'Retrieved account info from cache'
    );
    return accountInfo;
  }

  logger.info(
    { tag: 'get-account-info' },
    'Could not parse account information from cache, get from api'
  );

  return getAccountInfoFromAPI(logger);
};

/**
 * Get open orders
 *
 * @param {*} logger
 */
const getOpenOrdersFromAPI = async logger => {
  logger.info(
    { debug: true, function: 'openOrders' },
    'Retrieving open orders from API'
  );
  const openOrders = await binance.client.openOrders({
    recvWindow: 10000
  });
  logger.info({ openOrders }, 'Retrieved open orders from API');

  return openOrders;
};

/**
 * Get open orders
 *
 * @param {*} logger
 * @param {*} symbol
 */
const getOpenOrdersBySymbolFromAPI = async (logger, symbol) => {
  logger.info(
    { debug: true, function: 'openOrders' },
    'Retrieving open orders by symbol from API'
  );
  const openOrders = await binance.client.openOrders({
    symbol,
    recvWindow: 10000
  });
  logger.info({ openOrders }, 'Retrieved open orders by symbol from API');

  return openOrders;
};

/**
 * Refresh open orders for symbol open orders
 *  Get cached open orders and merge with symbol open orders
 *  This is necessary step to cover 2 seconds gap.
 *  The open orders cache will be refreshed with indicator job.
 *
 * @param {*} logger
 * @param {*} symbol
 */
const getAndCacheOpenOrdersForSymbol = async (logger, symbol) => {
  // Retrieve open orders from API first
  const symbolOpenOrders = await getOpenOrdersBySymbolFromAPI(logger, symbol);

  logger.info(
    {
      symbol,
      symbolOpenOrders
    },
    'Open orders from API'
  );

  await cache.hset(
    'trailing-trade-orders',
    symbol,
    JSON.stringify(symbolOpenOrders)
  );

  return symbolOpenOrders;
};

/**
 * Get last buy price from mongodb
 *
 * @param {*} logger
 * @param {*} symbol
 */
const getLastBuyPrice = async (logger, symbol) =>
  mongo.findOne(logger, 'trailing-trade-symbols', {
    key: `${symbol}-last-buy-price`
  });

/**
 * Save last buy price to mongodb
 *
 * @param {*} logger
 * @param {*} symbol
 * @param {*} param2
 */
const saveLastBuyPrice = async (logger, symbol, { lastBuyPrice, quantity }) => {
  logger.info(
    { tag: 'save-last-buy-price', symbol, lastBuyPrice, quantity },
    'Save last buy price'
  );
  return mongo.upsertOne(
    logger,
    'trailing-trade-symbols',
    { key: `${symbol}-last-buy-price` },
    {
      key: `${symbol}-last-buy-price`,
      lastBuyPrice,
      quantity
    }
  );
};

/**
 * Lock symbol
 *
 * @param {*} logger
 * @param {*} symbol
 * @param {*} ttl
 *
 * @returns
 */
const lockSymbol = async (logger, symbol, ttl = 5) => {
  logger.info({ debug: true, symbol }, `Lock ${symbol} for ${ttl} seconds`);
  return cache.set(`lock-${symbol}`, true, ttl);
};

/**
 * Check if symbol is locked
 *
 * @param {*} _logger
 * @param {*} symbol
 * @returns
 */
const isSymbolLocked = async (logger, symbol) => {
  const isLocked = (await cache.get(`lock-${symbol}`)) === 'true';

  if (isLocked === true) {
    logger.info(
      { debug: true, symbol, isLocked },
      `🔒 Symbol is locked - ${symbol}`
    );
  } else {
    logger.info(
      { debug: true, symbol, isLocked },
      `🔓 Symbol is not locked - ${symbol} `
    );
  }
  return isLocked;
};

/**
 * Unlock symbol
 *
 * @param {*} logger
 * @param {*} symbol
 * @returns
 */
const unlockSymbol = async (logger, symbol) => {
  logger.info({ debug: true, symbol }, `Unlock ${symbol}`);
  return cache.del(`lock-${symbol}`);
};

/**
 * Disable action
 *
 * @param {*} symbol
 * @param {*} reason
 * @param {*} ttl
 *
 * @returns
 */
const disableAction = async (symbol, reason, ttl) =>
  cache.set(`${symbol}-disable-action`, JSON.stringify(reason), ttl);

/**
 * Check if the action is disabled.
 *
 * @param {*} symbol
 * @returns
 */
const isActionDisabled = async symbol => {
  const result = await cache.getWithTTL(`${symbol}-disable-action`);

  const ttl = result[0][1];
  const reason = JSON.parse(result[1][1]) || {};

  return { isDisabled: ttl > 0, ttl, ...reason };
};

/**
 * Re-enable action stopped by stop loss
 *
 * @param {*} logger
 * @param {*} symbol
 * @returns
 */
const deleteDisableAction = async (logger, symbol) => {
  logger.info({ debug: true, symbol }, `Enable action for ${symbol}`);
  return cache.del(`${symbol}-disable-action`);
};

/**
 * Get API limit
 *
 * @param {*} logger
 * @returns
 */
const getAPILimit = logger => {
  const apiInfo = binance.client.getInfo();
  logger.info({ apiInfo }, 'API info');

  return parseInt(apiInfo.spot?.usedWeight1m || 0, 10);
};

/**
 * Check if API limit is over
 *
 * @param {*} logger
 * @returns
 */
const isExceedAPILimit = logger => {
  const usedWeight1m = getAPILimit(logger);
  return usedWeight1m > 1180;
};

/**
 * Get override data for Symbol
 *
 * @param {*} logger
 * @param {*} symbol
 * @returns
 */
const getOverrideDataForSymbol = async (_logger, symbol) => {
  const overrideData = await cache.hget('trailing-trade-override', symbol);
  if (!overrideData) {
    return null;
  }

  return JSON.parse(overrideData);
};

/**
 * Remove override data for Symbol
 *
 * @param {*} _logger
 * @param {*} symbol
 * @returns
 */
const removeOverrideDataForSymbol = async (_logger, symbol) =>
  cache.hdel('trailing-trade-override', symbol);

/**
 * Get override data for Indicator
 *
 * @param {*} logger
 * @param {*} key
 * @returns
 */
const getOverrideDataForIndicator = async (_logger, key) => {
  const overrideData = await cache.hget(
    'trailing-trade-indicator-override',
    key
  );
  if (!overrideData) {
    return null;
  }

  return JSON.parse(overrideData);
};

/**
 * Remove override data for Indicator
 *
 * @param {*} _logger
 * @param {*} key
 * @returns
 */
const removeOverrideDataForIndicator = async (_logger, key) =>
  cache.hdel('trailing-trade-indicator-override', key);

module.exports = {
  cacheExchangeSymbols,
  getAccountInfoFromAPI,
  getAccountInfo,
  extendBalancesWithDustTransfer,
  getOpenOrdersFromAPI,
  getOpenOrdersBySymbolFromAPI,
  getAndCacheOpenOrdersForSymbol,
  getLastBuyPrice,
  saveLastBuyPrice,
  lockSymbol,
  isSymbolLocked,
  unlockSymbol,
  disableAction,
  isActionDisabled,
  deleteDisableAction,
  getAPILimit,
  isExceedAPILimit,
  getOverrideDataForSymbol,
  removeOverrideDataForSymbol,
  getOverrideDataForIndicator,
  removeOverrideDataForIndicator
};
