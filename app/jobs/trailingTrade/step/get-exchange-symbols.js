const _ = require('lodash');
const { binance, cache } = require('../../../helpers');

/**
 * Get exchange symbols and cache it
 *
 * @param {*} logger
 * @param {*} rawData
 */
const execute = async (logger, rawData) => {
  const data = rawData;
  const {
    globalConfiguration: { supportFIATs }
  } = data;

  const cachedExchangeInfo = await cache.hget(
    'trailing-trade-common',
    'exchange-symbols'
  );

  if (_.isEmpty(cachedExchangeInfo) === false) {
    logger.info(
      { cachedExchangeInfo },
      'Retrieved exchange information from cache'
    );
    return data;
  }

  const exchangeInfo = await binance.client.exchangeInfo();

  logger.info({ supportFIATs }, 'Support FIATs');
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
  logger.info({ exchangeSymbols }, 'Retrieved exchange symbols');

  return data;
};

module.exports = { execute };
