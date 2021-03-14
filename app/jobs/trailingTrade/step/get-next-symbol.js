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
    'last-symbol'
  );

  logger.info({ cachedLastSymbol }, 'Cached last symbol');
  let currentSymbol = symbols[0];
  if (cachedLastSymbol) {
    const cachedSymbolIndex = symbols.indexOf(cachedLastSymbol);
    currentSymbol = symbols[cachedSymbolIndex + 1] || symbols[0];
  }

  logger.info({ currentSymbol }, 'Determined current symbol');
  await cache.hset('trailing-trade-common', 'last-symbol', currentSymbol);

  data.symbol = currentSymbol;

  return data;
};

module.exports = { execute };
