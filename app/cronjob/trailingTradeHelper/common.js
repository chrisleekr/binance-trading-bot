const config = require('config');
const jwt = require('jsonwebtoken');
const _ = require('lodash');
const moment = require('moment');
const { cache, binance, mongo, PubSub, slack } = require('../../helpers');

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
      JSON.stringify(exchangeInfo),
      3600
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
    JSON.stringify(exchangeSymbols),
    3600
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
      // In order to qualify the dust must have a value less than 0.001BTC

      balance.estimatedBTC = Number(
        parseFloat(cachedLatestCandle.close) * parseFloat(balance.free)
      ).toFixed(8);

      // If the estimated BTC is less than 0.001, then set dust transfer
      if (balance.estimatedBTC <= 0.001) {
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
  logger.info({ function: 'openOrders' }, 'Retrieving open orders from API');
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
    { function: 'openOrders' },
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
    'trailing-trade-open-orders',
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
    { lastBuyPrice, quantity, saveLog: true },
    'The last buy price has been saved.'
  );
  const result = await mongo.upsertOne(
    logger,
    'trailing-trade-symbols',
    { key: `${symbol}-last-buy-price` },
    {
      key: `${symbol}-last-buy-price`,
      lastBuyPrice,
      quantity
    }
  );

  // Refresh configuration
  await cache.hdel('trailing-trade-configurations', symbol);

  return result;
};

const removeLastBuyPrice = async (logger, symbol) => {
  logger.info({ saveLog: true }, 'The last buy price has been removed.');

  const result = await mongo.deleteOne(logger, 'trailing-trade-symbols', {
    key: `${symbol}-last-buy-price`
  });

  // Refresh configuration
  await cache.hdel('trailing-trade-configurations', symbol);

  return result;
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
  logger.info({ symbol }, `Lock ${symbol} for ${ttl} seconds`);
  return cache.hset('bot-lock', symbol, true, ttl);
};

/**
 * Check if symbol is locked
 *
 * @param {*} _logger
 * @param {*} symbol
 * @returns
 */
const isSymbolLocked = async (logger, symbol) => {
  const isLocked = (await cache.hget('bot-lock', symbol)) === 'true';

  if (isLocked === true) {
    logger.info({ symbol, isLocked }, `🔒 Symbol is locked - ${symbol}`);
  } else {
    logger.info({ symbol, isLocked }, `🔓 Symbol is not locked - ${symbol} `);
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
  logger.info({ symbol }, `Unlock ${symbol}`);
  return cache.hdel('bot-lock', symbol);
};

/**
 * Disable action
 *
 * @param {*} logger
 * @param {*} symbol
 * @param {*} reason
 * @param {*} ttl
 *
 * @returns
 */
const disableAction = async (logger, symbol, reason, ttl) => {
  logger.info(
    { reason, ttl, saveLog: true },
    `The action is disabled. Reason: ${_.get(reason, 'message', 'Unknown')}`
  );
  return cache.set(`${symbol}-disable-action`, JSON.stringify(reason), ttl);
};

/**
 * Check if the action is disabled.
 *
 * @param {*} symbol
 * @returns
 */
const isActionDisabled = async symbol => {
  const result = await cache.getWithTTL(`${symbol}-disable-action`);

  if (result === null) {
    return { isDisabled: false, ttl: -2 };
  }

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
  logger.info({ saveLog: true }, `The action is enabled.`);
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
const removeOverrideDataForSymbol = async (logger, symbol) => {
  logger.info({ saveLog: true }, 'The override data is removed.');

  return cache.hdel('trailing-trade-override', symbol);
};

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

/**
 * Retrieve last buy price and recalculate new last buy price
 *
 * @param {*} logger
 * @param {*} symbol
 * @param {*} order
 */
const calculateLastBuyPrice = async (logger, symbol, order) => {
  const { type, executedQty, cummulativeQuoteQty } = order;
  const lastBuyPriceDoc = await getLastBuyPrice(logger, symbol);

  const orgLastBuyPrice = _.get(lastBuyPriceDoc, 'lastBuyPrice', 0);
  const orgQuantity = _.get(lastBuyPriceDoc, 'quantity', 0);
  const orgTotalAmount = orgLastBuyPrice * orgQuantity;

  logger.info(
    { orgLastBuyPrice, orgQuantity, orgTotalAmount },
    'Existing last buy price'
  );

  const filledQuoteQty = parseFloat(cummulativeQuoteQty);
  const filledQuantity = parseFloat(executedQty);

  const newQuantity = orgQuantity + filledQuantity;
  const newTotalAmount = orgTotalAmount + filledQuoteQty;

  const newLastBuyPrice = newTotalAmount / newQuantity;

  logger.info(
    { newLastBuyPrice, newTotalAmount, newQuantity, saveLog: true },
    `The last buy price will be saved. New last buy price: ${newLastBuyPrice}`
  );
  await saveLastBuyPrice(logger, symbol, {
    lastBuyPrice: newLastBuyPrice,
    quantity: newQuantity
  });

  PubSub.publish('frontend-notification', {
    type: 'success',
    title: `New last buy price for ${symbol} has been updated.`
  });

  slack.sendMessage(
    `${symbol} Last buy price Updated (${moment().format(
      'HH:mm:ss.SSS'
    )}): *${type}*\n` +
      `- Order Result: \`\`\`${JSON.stringify(
        {
          orgLastBuyPrice,
          orgQuantity,
          orgTotalAmount,
          newLastBuyPrice,
          newQuantity,
          newTotalAmount
        },
        undefined,
        2
      )}\`\`\`\n` +
      `- Current API Usage: ${getAPILimit(logger)}`
  );
};

/**
 * Get symbol information
 *
 * @param {*} logger
 * @param {*} symbol
 */
const getSymbolInfo = async (logger, symbol) => {
  const cachedSymbolInfo =
    JSON.parse(
      await cache.hget('trailing-trade-symbols', `${symbol}-symbol-info`)
    ) || {};

  if (_.isEmpty(cachedSymbolInfo) === false) {
    logger.info({ cachedSymbolInfo }, 'Retrieved symbol info from the cache.');
    return cachedSymbolInfo;
  }

  const cachedExchangeInfo =
    JSON.parse(await cache.hget('trailing-trade-common', 'exchange-info')) ||
    {};

  let exchangeInfo = cachedExchangeInfo;
  if (_.isEmpty(cachedExchangeInfo) === true) {
    logger.info(
      { function: 'exchangeInfo' },
      'Request exchange info from Binance.'
    );
    exchangeInfo = await binance.client.exchangeInfo();

    await cache.hset(
      'trailing-trade-common',
      'exchange-info',
      JSON.stringify(exchangeInfo),
      3600
    );
  }

  logger.info({}, 'Retrieved exchange info.');
  const symbolInfo = _.filter(
    exchangeInfo.symbols,
    s => s.symbol === symbol
  )[0];

  // eslint-disable-next-line prefer-destructuring
  symbolInfo.filterLotSize = _.filter(
    symbolInfo.filters,
    f => f.filterType === 'LOT_SIZE'
  )[0];
  // eslint-disable-next-line prefer-destructuring
  symbolInfo.filterPrice = _.filter(
    symbolInfo.filters,
    f => f.filterType === 'PRICE_FILTER'
  )[0];
  // eslint-disable-next-line prefer-destructuring
  symbolInfo.filterMinNotional = _.filter(
    symbolInfo.filters,
    f => f.filterType === 'MIN_NOTIONAL'
  )[0];

  logger.info({ symbolInfo }, 'Retrieved symbol info from Binance.');

  const finalSymbolInfo = _.pick(symbolInfo, [
    'symbol',
    'status',
    'baseAsset',
    'baseAssetPrecision',
    'quoteAsset',
    'quotePrecision',
    'filterLotSize',
    'filterPrice',
    'filterMinNotional'
  ]);

  cache.hset(
    'trailing-trade-symbols',
    `${symbol}-symbol-info`,
    JSON.stringify(finalSymbolInfo),
    3600
  );

  return finalSymbolInfo;
};

/**
 * Verify authentication
 *
 * @param {*} funcLogger
 * @param {*} authToken
 * @returns
 */
const verifyAuthenticated = async (funcLogger, authToken) => {
  const logger = funcLogger.child({ tag: 'verifyAuthenticated' });

  const authenticationEnabled = config.get('authentication.enabled');
  if (authenticationEnabled === false) {
    logger.info('Authentication is not enabled.');
    return true;
  }

  const jwtSecret = await cache.get('auth-jwt-secret');

  logger.info({ authToken, jwtSecret }, 'Verifying authentication');
  let data = null;
  try {
    data = jwt.verify(authToken, jwtSecret, { algorithm: 'HS256' });
  } catch (err) {
    logger.info({ err }, 'Failed authentication');
    return false;
  }

  logger.info({ data }, 'Success authentication');
  return true;
};

/**
 * Save number of buy open orders
 *
 * @param {*} logger
 * @param {*} symbols
 */
const saveNumberOfBuyOpenOrders = async (logger, symbols) => {
  const numberOfBuyOpenOrders = await mongo.count(
    logger,
    'trailing-trade-grid-trade-orders',
    {
      key: {
        $regex: `(${symbols.join('|')})-grid-trade-last-buy-order`
      }
    }
  );

  await cache.hset(
    'trailing-trade-common',
    'number-of-buy-open-orders',
    numberOfBuyOpenOrders
  );
};

/**
 * Get number of buy open orders
 *
 * @param {*} _logger
 * @returns
 */
const getNumberOfBuyOpenOrders = async _logger =>
  parseInt(
    (await cache.hget('trailing-trade-common', 'number-of-buy-open-orders')) ||
      0,
    10
  );

/**
 * Save number of active orders
 *
 * @param {*} logger
 * @param {*} symbols
 */
const saveNumberOfOpenTrades = async (logger, symbols) => {
  const numberOfOpenTrades = await mongo.count(
    logger,
    'trailing-trade-symbols',
    {
      key: {
        $regex: `(${symbols.join('|')})-last-buy-price`
      }
    }
  );

  await cache.hset(
    'trailing-trade-common',
    'number-of-open-trades',
    numberOfOpenTrades
  );
};

/**
 * Get number of open trades
 *
 * @param {*} _logger
 * @returns
 */
const getNumberOfOpenTrades = async _logger =>
  parseInt(
    (await cache.hget('trailing-trade-common', 'number-of-open-trades')) || 0,
    10
  );

/**
 * Save order statistics
 *
 * @param {*} logger
 * @param {*} symbols
 * @returns
 */
const saveOrderStats = async (logger, symbols) =>
  Promise.all([
    saveNumberOfBuyOpenOrders(logger, symbols),
    saveNumberOfOpenTrades(logger, symbols)
  ]);

/**
 * Save override action
 *
 * @param {*} logger
 * @param {*} symbol
 * @param {*} overrideData
 * @param {*} overrideReason
 */
const saveOverrideAction = async (
  logger,
  symbol,
  overrideData,
  overrideReason
) => {
  logger.info(
    { overrideData, overrideReason, saveLog: true },
    `The override action is saved. Reason: ${overrideReason}`
  );

  await cache.hset(
    'trailing-trade-override',
    `${symbol}`,
    JSON.stringify(overrideData)
  );

  const notify = _.get(overrideData, 'notify', true);

  if (notify) {
    slack.sendMessage(
      `${symbol} Action (${moment().format('HH:mm:ss.SSS')}): Queued action: ${
        overrideData.action
      }\n` +
        `- Message: ${overrideReason}\n` +
        `- Current API Usage: ${getAPILimit(logger)}`
    );

    PubSub.publish('frontend-notification', {
      type: 'info',
      title: overrideReason
    });
  }
};

/**
 * Save override action for indicator
 *
 * @param {*} logger
 * @param {*} symbol
 * @param {*} overrideData
 * @param {*} overrideReason
 */
const saveOverrideIndicatorAction = async (
  logger,
  type,
  overrideData,
  overrideReason
) => {
  await cache.hset(
    'trailing-trade-indicator-override',
    type,
    JSON.stringify(overrideData)
  );

  const notify = _.get(overrideData, 'notify', true);

  if (notify) {
    slack.sendMessage(
      `Action (${moment().format('HH:mm:ss.SSS')}): Queued action: ${
        overrideData.action
      }\n` +
        `- Message: ${overrideReason}\n` +
        `- Current API Usage: ${getAPILimit(logger)}`
    );

    PubSub.publish('frontend-notification', {
      type: 'info',
      title: overrideReason
    });
  }
};

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
  removeLastBuyPrice,
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
  removeOverrideDataForIndicator,
  calculateLastBuyPrice,
  getSymbolInfo,
  verifyAuthenticated,
  saveNumberOfBuyOpenOrders,
  getNumberOfBuyOpenOrders,
  saveNumberOfOpenTrades,
  getNumberOfOpenTrades,
  saveOrderStats,
  saveOverrideAction,
  saveOverrideIndicatorAction
};
