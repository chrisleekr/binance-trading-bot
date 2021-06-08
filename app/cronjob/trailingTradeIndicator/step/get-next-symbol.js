const { cache } = require('../../../helpers');

/**
 * Get next symbol
 *
 * @param {*} logger
 * @param {*} rawData
 */
const execute = async (logger, rawData) => {
  const data = rawData;

  const {
    globalConfiguration: { symbols }
  } = data;

  // Get last symbol from cache
  const cachedLastSymbol = await cache.hget(
    'trailing-trade-common',
    'last-indicator-symbol'
  );

  logger.info(
    { tag: 'get-next-symbol', cachedLastSymbol, symbols },
    'Cached last symbol'
  );
  let currentSymbol = symbols[0];
  if (cachedLastSymbol) {
    const cachedSymbolIndex = symbols.indexOf(cachedLastSymbol);
    currentSymbol = symbols[cachedSymbolIndex + 1] || symbols[0];
  }

  logger.info(
    { tag: 'get-next-symbol', currentSymbol },
    'Determined current symbol'
  );
  await cache.hset(
    'trailing-trade-common',
    'last-indicator-symbol',
    currentSymbol
  );

  data.symbol = currentSymbol;

  return data;
};

module.exports = { execute };
