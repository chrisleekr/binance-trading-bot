/* eslint-disable prefer-destructuring */
const _ = require('lodash');
const { binance, cache } = require('../../../helpers');

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
      { debug: true, function: 'exchangeInfo' },
      'Request exchange info from Binance.'
    );
    exchangeInfo = await binance.client.exchangeInfo();
    await cache.hset(
      'trailing-trade-common',
      'exchange-info',
      JSON.stringify(exchangeInfo)
    );
  }

  logger.info({}, 'Retrieved exchange info.');
  const symbolInfo = _.filter(
    exchangeInfo.symbols,
    s => s.symbol === symbol
  )[0];

  symbolInfo.filterLotSize = _.filter(
    symbolInfo.filters,
    f => f.filterType === 'LOT_SIZE'
  )[0];
  symbolInfo.filterPrice = _.filter(
    symbolInfo.filters,
    f => f.filterType === 'PRICE_FILTER'
  )[0];
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
    JSON.stringify(finalSymbolInfo)
  );

  return finalSymbolInfo;
};

/**
 * Get symbol info from Binance/cache
 *
 * @param {*} logger
 * @param {*} rawData
 */
const execute = async (logger, rawData) => {
  const data = rawData;

  const { symbol } = data;

  // Retrieve symbol info
  const symbolInfo = await getSymbolInfo(logger, symbol);

  data.symbolInfo = symbolInfo;

  return data;
};

module.exports = { execute };
