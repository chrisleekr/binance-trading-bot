const config = require('config');
const jwt = require('jsonwebtoken');
const _ = require('lodash');
const { cache, binance, mongo, PubSub, slack } = require('../../helpers');

const isValidCachedExchangeSymbols = exchangeSymbols =>
  _.get(
    exchangeSymbols,
    [Object.keys(exchangeSymbols)[0], 'minNotional'],
    null
  ) !== null;

const getCachedExchangeSymbols = async _logger =>
  JSON.parse(await cache.hget('trailing-trade-common', 'exchange-symbols')) ||
  {};

const getCachedExchangeInfo = async logger => {
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

  return exchangeInfo;
};

/**
 * Retreive cached exhcnage symbols.
 *  If not cached, retrieve exchange info from API and cache it.
 *
 * @param {*} logger
 */
const cacheExchangeSymbols = async logger => {
  const cachedExchangeSymbols = await getCachedExchangeSymbols(logger);
  // If there is already cached exchange symbols, don't need to cache again.
  if (
    _.isEmpty(cachedExchangeSymbols) === false &&
    // For backward compatibility, verify the cached value is valid.
    isValidCachedExchangeSymbols(cachedExchangeSymbols) === true
  ) {
    return;
  }

  // Retrieve cached exchange information
  const exchangeInfo = await getCachedExchangeInfo(logger);

  logger.info('Retrieved exchange info from API');

  const { symbols } = exchangeInfo;

  const exchangeSymbols = symbols.reduce((acc, symbol) => {
    // For backward compatibility, MIN_NOTIONAL is deprecated.
    const minNotionalFilter = _.find(symbol.filters, {
      filterType: 'MIN_NOTIONAL'
    });

    // New filter type is NOTIONAL.
    const notionalFilter = _.find(symbol.filters, {
      filterType: 'NOTIONAL'
    });

    acc[symbol.symbol] = {
      symbol: symbol.symbol,
      status: symbol.status,
      quoteAsset: symbol.quoteAsset,
      minNotional: minNotionalFilter
        ? parseFloat(minNotionalFilter.minNotional)
        : parseFloat(notionalFilter.minNotional)
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
 * Add estimatedBTC and canDustTransfer flags to balance
 *  - Leave this function for future reference
 *
 * @param {*} _logger
 * @param {*} rawAccountInfo
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
 * Retrieve account info from cache
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
 * @param {*} _logger
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
 * @param {*} logger
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
 * @param {*} _logger
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

  const notifyDebug = config.get('featureToggle.notifyDebug');
  const notifyOrderConfirm = config.get('featureToggle.notifyOrderConfirm');

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

  if (notifyDebug || notifyOrderConfirm)
    slack.sendMessage(
      `*${symbol}* Last buy price Updated: *${type}*\n` +
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
        )}\`\`\``,
      { symbol, apiLimit: getAPILimit(logger) }
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

  const exchangeInfo = await getCachedExchangeInfo(logger);

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
  // eslint-disable-next-line prefer-destructuring
  symbolInfo.filterNotional = _.filter(
    symbolInfo.filters,
    f => f.filterType === 'NOTIONAL'
  )[0];

  // This is for a backward compatibility that filterMinNotional is not available.
  if (symbolInfo.filterNotional) {
    symbolInfo.filterMinNotional = symbolInfo.filterNotional;
  }

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

  await cache.hset(
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
 * Save number of buy open orders and list of symbols with open orders
 *
 * @param {*} logger
 * @param {*} symbols
 */
const saveNumberOfBuyOpenOrders = async (logger, symbols) => {
  const buyOpenOrders = await mongo.aggregate(
    logger,
    'trailing-trade-grid-trade-orders',
    [
      {
        $match: {
          key: {
            $regex: `(${symbols.join('|')})-grid-trade-last-buy-order`
          }
        }
      },
      {
        $project: {
          _id: 0,
          key: 1
        }
      }
    ]
  );

  const openOrders = _.map(buyOpenOrders, order =>
    order.key.replace('-grid-trade-last-buy-order', '')
  );

  await cache.hset(
    'trailing-trade-common',
    'open-orders-symbols',
    JSON.stringify(openOrders)
  );

  await cache.hset(
    'trailing-trade-common',
    'number-of-buy-open-orders',
    openOrders.length
  );
};

/**
 * Get symbols with open orders
 *
 * @param {*} _logger
 * @returns
 */
const getOpenOrdersSymbols = async _logger =>
  JSON.parse(
    await cache.hget('trailing-trade-common', 'open-orders-symbols')
  ) || [];

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
 * Save number of active orders and list of symbols with active orders
 *
 * @param {*} logger
 * @param {*} symbols
 */
const saveNumberOfOpenTrades = async (logger, symbols) => {
  const openTradesSymbols = await mongo.aggregate(
    logger,
    'trailing-trade-symbols',
    [
      {
        $match: {
          key: {
            $regex: `(${symbols.join('|')})-last-buy-price`
          }
        }
      },
      {
        $project: {
          _id: 0,
          key: 1
        }
      }
    ]
  );

  const openTrades = _.map(openTradesSymbols, trade =>
    trade.key.replace('-last-buy-price', '')
  );

  await cache.hset(
    'trailing-trade-common',
    'open-trades-symbols',
    JSON.stringify(openTrades)
  );

  await cache.hset(
    'trailing-trade-common',
    'number-of-open-trades',
    openTrades.length
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
 * Get symbols with open trades
 *
 * @param {*} _logger
 * @returns
 */
const getOpenTradesSymbols = async _logger =>
  JSON.parse(
    await cache.hget('trailing-trade-common', 'open-trades-symbols')
  ) || [];

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
    { symbol, overrideData, overrideReason, saveLog: true },
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
      `*${symbol}* Action - Queued action: ${overrideData.action}\n` +
        `- Message: ${overrideReason}`,
      { symbol, apiLimit: getAPILimit(logger) }
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
 * @param {*} type
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
      `Action - Queued action: ${overrideData.action}\n` +
        `- Message: ${overrideReason}`,
      { apiLimit: getAPILimit(logger) }
    );

    PubSub.publish('frontend-notification', {
      type: 'info',
      title: overrideReason
    });
  }
};

/**
 * Save or update symbol candle based on time
 *
 * @param {*} logger
 * @param collectionName
 * @param candle
 */
const saveCandle = async (logger, collectionName, candle) => {
  const { key, interval, time } = candle;
  await mongo.upsertOne(
    logger,
    collectionName,
    {
      key,
      time,
      interval
    },
    candle
  );
};

/**
 * Update account info with new one
 *
 * @param {*} logger
 * @param balances
 * @param lastAccountUpdate
 */
const updateAccountInfo = async (logger, balances, lastAccountUpdate) => {
  logger.info({ balances }, 'Updating account balances');
  const accountInfo = await getAccountInfo(logger);

  const mergedBalances = _.merge(
    _.keyBy(accountInfo.balances, 'asset'),
    _.keyBy(balances, 'asset')
  );
  accountInfo.balances = _.reduce(
    _.values(mergedBalances),
    (acc, b) => {
      const balance = b;
      if (+balance.free > 0 || +balance.locked > 0) {
        acc.push(balance);
      }

      return acc;
    },
    []
  );

  // set updateTime manually because we are updating account info from websocket
  accountInfo.updateTime = lastAccountUpdate;

  await cache.hset(
    'trailing-trade-common',
    'account-info',
    JSON.stringify(accountInfo)
  );

  return accountInfo;
};

const countCacheTrailingTradeSymbols = async logger => {
  const result = await mongo.aggregate(logger, 'trailing-trade-cache', [
    { $match: {} },
    { $group: { _id: null, count: { $sum: 1 } } }
  ]);

  return _.get(result, ['0', 'count'], 0);
};

const getCacheTrailingTradeSymbols = async (
  logger,
  sortByDesc,
  sortByParam,
  page,
  symbolsPerPage,
  searchKeyword
) => {
  const match = {};

  if (searchKeyword === 'open trades') {
    const openTradesSymbols = await getOpenTradesSymbols(logger);
    match.symbol = {
      $regex: `(${openTradesSymbols.join('|')})`,
      $options: 'i'
    };
  } else if (searchKeyword === 'open orders') {
    const openOrdersSymbols = await getOpenOrdersSymbols(logger);
    match.symbol = {
      $regex: `(${openOrdersSymbols.join('|')})`,
      $options: 'i'
    };
  } else if (searchKeyword) {
    match.symbol = {
      $regex: searchKeyword,
      $options: 'i'
    };
  }

  const sortBy = sortByParam || 'default';
  const sortDirection = sortByDesc === true ? -1 : 1;
  const pageNum = _.toNumber(page) >= 1 ? _.toNumber(page) : 1;

  logger.info({ sortBy, sortDirection }, 'latest');

  let sortField = {
    $cond: {
      if: { $gt: [{ $size: '$buy.openOrders' }, 0] },
      then: {
        $multiply: [
          {
            $add: [
              {
                $let: {
                  vars: {
                    buyOpenOrder: {
                      $arrayElemAt: ['$buy.openOrders', 0]
                    }
                  },
                  in: '$buyOpenOrder.differenceToCancel'
                }
              },
              3000
            ]
          },
          -10
        ]
      },
      else: {
        $cond: {
          if: { $gt: [{ $size: '$sell.openOrders' }, 0] },
          then: {
            $multiply: [
              {
                $add: [
                  {
                    $let: {
                      vars: {
                        sellOpenOrder: {
                          $arrayElemAt: ['$sell.openOrders', 0]
                        }
                      },
                      in: '$sellOpenOrder.differenceToCancel'
                    }
                  },
                  2000
                ]
              },
              -10
            ]
          },
          else: {
            $cond: {
              if: {
                $eq: ['$sell.difference', null]
              },
              then: '$buy.difference',
              else: {
                $multiply: [{ $add: ['$sell.difference', 1000] }, -10]
              }
            }
          }
        }
      }
    }
  };

  if (sortBy === 'buy-difference') {
    sortField = {
      $cond: {
        if: {
          $eq: ['$buy.difference', null]
        },
        then: sortByDesc ? -Infinity : Infinity,
        else: '$buy.difference'
      }
    };
  }

  if (sortBy === 'sell-profit') {
    sortField = {
      $cond: {
        if: {
          $eq: ['$sell.currentProfitPercentage', null]
        },
        then: sortByDesc ? -Infinity : Infinity,
        else: '$sell.currentProfitPercentage'
      }
    };
  }

  if (sortBy === 'alpha') {
    sortField = '$symbol';
  }

  const trailingTradeCacheQuery = [
    {
      $match: match
    },
    {
      $project: {
        symbol: '$symbol',
        lastCandle: '$lastCandle',
        symbolInfo: '$symbolInfo',
        symbolConfiguration: '$symbolConfiguration',
        baseAssetBalance: '$baseAssetBalance',
        quoteAssetBalance: '$quoteAssetBalance',
        buy: '$buy',
        sell: '$sell',
        tradingView: '$tradingView',
        overrideData: '$overrideData',
        sortField
      }
    },
    { $sort: { sortField: sortDirection, symbol: 1 } },
    { $skip: (pageNum - 1) * symbolsPerPage },
    { $limit: symbolsPerPage }
  ];

  return mongo.aggregate(
    logger,
    'trailing-trade-cache',
    trailingTradeCacheQuery
  );
};

const getCacheTrailingTradeTotalProfitAndLoss = logger =>
  mongo.aggregate(logger, 'trailing-trade-cache', [
    {
      $group: {
        _id: '$quoteAssetBalance.asset',
        amount: {
          $sum: {
            $multiply: ['$baseAssetBalance.total', '$sell.lastBuyPrice']
          }
        },
        profit: { $sum: '$sell.currentProfit' },
        estimatedBalance: { $sum: '$baseAssetBalance.estimatedValue' },
        free: { $first: '$quoteAssetBalance.free' },
        locked: { $first: '$quoteAssetBalance.locked' }
      }
    },
    {
      $project: {
        asset: '$_id',
        amount: '$amount',
        profit: '$profit',
        estimatedBalance: '$estimatedBalance',
        free: '$free',
        locked: '$locked'
      }
    }
  ]);

const getCacheTrailingTradeQuoteEstimates = logger =>
  mongo.aggregate(logger, 'trailing-trade-cache', [
    {
      $match: {
        'baseAssetBalance.estimatedValue': {
          $gt: 0
        }
      }
    },
    {
      $project: {
        baseAsset: '$symbolInfo.baseAsset',
        quoteAsset: '$symbolInfo.quoteAsset',
        estimatedValue: '$baseAssetBalance.estimatedValue',
        tickSize: '$symbolInfo.filterPrice.tickSize'
      }
    }
  ]);

/**
 * Check whether max number of open trades has reached
 *
 * @param {*} logger
 * @param {*} data
 * @returns
 */
const isExceedingMaxOpenTrades = async (logger, data) => {
  const {
    symbolConfiguration: {
      botOptions: {
        orderLimit: {
          enabled: orderLimitEnabled,
          maxOpenTrades: orderLimitMaxOpenTrades
        }
      }
    },
    sell: { lastBuyPrice }
  } = data;

  if (orderLimitEnabled === false) {
    return false;
  }

  // If the last buy price is recorded, this is one of open trades.
  if (lastBuyPrice) {
    return false;
  }

  return (await getNumberOfOpenTrades(logger)) >= orderLimitMaxOpenTrades;
};

/**
 * Cancel order
 *
 * @param {*} logger
 * @param {*} symbol
 * @param {*} order
 */
const cancelOrder = async (logger, symbol, order) => {
  const { side } = order;
  logger.info(
    { function: 'cancelOrder', order, saveLog: true },
    `The ${side} order will be cancelled.`
  );
  // Cancel open orders first to make sure it does not have unsettled orders.
  let result = false;
  try {
    const apiResult = await binance.client.cancelOrder({
      symbol,
      orderId: order.orderId
    });
    logger.info({ apiResult }, 'Cancelled open orders');

    result = true;
  } catch (e) {
    logger.info(
      { e, saveLog: true },
      `Order cancellation failed, but it is ok. ` +
        `The order may already be cancelled or executed. The bot will check in the next tick.`
    );
  }

  return result;
};

const refreshOpenOrdersAndAccountInfo = async (logger, symbol) => {
  // Get open orders
  const openOrders = await getAndCacheOpenOrdersForSymbol(logger, symbol);

  // Refresh account info
  const accountInfo = await getAccountInfoFromAPI(logger);

  const buyOpenOrders = openOrders.filter(o => o.side.toLowerCase() === 'buy');

  const sellOpenOrders = openOrders.filter(
    o => o.side.toLowerCase() === 'sell'
  );

  return {
    accountInfo,
    openOrders,
    buyOpenOrders,
    sellOpenOrders
  };
};

module.exports = {
  cacheExchangeSymbols,
  getCachedExchangeSymbols,
  getCachedExchangeInfo,
  getAccountInfoFromAPI,
  getAccountInfo,
  extendBalancesWithDustTransfer,
  getOpenOrdersFromAPI,
  getOpenOrdersBySymbolFromAPI,
  getAndCacheOpenOrdersForSymbol,
  getLastBuyPrice,
  saveLastBuyPrice,
  removeLastBuyPrice,
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
  getOpenOrdersSymbols,
  saveNumberOfOpenTrades,
  getNumberOfOpenTrades,
  getOpenTradesSymbols,
  saveOrderStats,
  saveOverrideAction,
  saveOverrideIndicatorAction,
  saveCandle,
  updateAccountInfo,
  countCacheTrailingTradeSymbols,
  getCacheTrailingTradeSymbols,
  getCacheTrailingTradeTotalProfitAndLoss,
  getCacheTrailingTradeQuoteEstimates,
  isExceedingMaxOpenTrades,
  cancelOrder,
  refreshOpenOrdersAndAccountInfo
};
