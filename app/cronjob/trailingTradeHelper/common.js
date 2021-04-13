const _ = require('lodash');
const { cache, binance, mongo } = require('../../helpers');

/**
 * Retreive cached exhcnage symbols.
 *  If not cached, retrieve exchange info from API and cache it.
 *
 * @param {*} logger
 * @param {*} globalConfiguration
 */
const cacheExchangeSymbols = async (logger, globalConfiguration) => {
  const { supportFIATs } = globalConfiguration;
  logger.info({ supportFIATs }, 'Support FIATs');

  const cachedExchangeSymbols =
    JSON.parse(await cache.hget('trailing-trade-common', 'exchange-symbols')) ||
    {};

  // If there is already cached exchange symbols, don't need to cache again.
  if (_.isEmpty(cachedExchangeSymbols) === false) {
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
    if (new RegExp(supportFIATs.join('|')).test(symbol.symbol)) {
      acc.push(symbol.symbol);
    }

    return acc;
  }, []);

  await cache.hset(
    'trailing-trade-common',
    'exchange-symbols',
    JSON.stringify(exchangeSymbols)
  );
  logger.info({ exchangeSymbols }, 'Saved exchange symbols to cache');
};

/**
 * Retrieve account information from API and filter balances
 *
 * @param {*} logger
 */
const getAccountInfoFromAPI = async logger => {
  logger.info({ function: 'accountInfo' }, 'Retrieving account info from API');
  const accountInfo = await binance.client.accountInfo();

  accountInfo.balances = accountInfo.balances.reduce((acc, b) => {
    const balance = b;
    if (+balance.free > 0 || +balance.locked > 0) {
      acc.push(balance);
    }

    return acc;
  }, []);

  logger.info(
    { debug: true, function: 'accountInfo' },
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
    JSON.parse(await cache.hget('trailing-trade-common', 'account-info')) || {};

  if (_.isEmpty(accountInfo) === false) {
    logger.info({ accountInfo }, 'Retrieved account info from cache');
    return accountInfo;
  }

  logger.info(
    { debug: true },
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
 * Retrieve open orders from cache
 *
 * @param {*} logger
 */
const getOpenOrdersFromCache = async logger => {
  const cachedOpenOrders =
    JSON.parse(await cache.hgetall('trailing-trade-orders')) || [];

  logger.info({ cachedOpenOrders }, 'Retrieved open orders from cache');

  const openOrders = [];
  _.forIn(cachedOpenOrders, value => {
    openOrders.push(value);
  });

  return openOrders;
};

/**
 * Get open orders
 *
 * @param {*} logger
 * @param {*} symbol
 */
const getOpenOrdersBySymbol = async (logger, symbol) => {
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
const getOpenOrdersForSymbol = async (logger, symbol) => {
  // Retrieve open orders from API first
  const symbolOpenOrders = await getOpenOrdersBySymbol(logger, symbol);

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
const getLastBuyPrice = async (logger, symbol) => {
  const lastBuyPriceDoc = await mongo.findOne(
    logger,
    'trailing-trade-symbols',
    {
      key: `${symbol}-last-buy-price`
    }
  );

  const cachedLastBuyPrice = _.get(lastBuyPriceDoc, 'lastBuyPrice', null);
  logger.debug({ cachedLastBuyPrice }, 'Last buy price from cache');

  return cachedLastBuyPrice;
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
      `Symbol is locked - ${symbol}`
    );
  } else {
    logger.info(
      { debug: true, symbol, isLocked },
      `Symbol is not locked - ${symbol} `
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

module.exports = {
  cacheExchangeSymbols,
  getAccountInfoFromAPI,
  getAccountInfo,
  getOpenOrdersFromCache,
  getOpenOrdersFromAPI,
  getOpenOrdersBySymbol,
  getOpenOrdersForSymbol,
  getLastBuyPrice,
  lockSymbol,
  isSymbolLocked,
  unlockSymbol
};
