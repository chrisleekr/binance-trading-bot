const { cache } = require('../../helpers');

const handleSymbolUpdate = async (logger, ws, payload) => {
  logger.info({ payload }, 'Start symbol update');

  const { data: symbolInfo } = payload;

  // Update last-buy-price
  const { symbol } = symbolInfo;

  const { lastBuyPrice } = symbolInfo.sell;

  await cache.hset(
    'simple-stop-chaser-symbols',
    `${symbol}-last-buy-price`,
    lastBuyPrice
  );

  ws.send(JSON.stringify({ result: true, type: 'symbol-update-result' }));
};

module.exports = { handleSymbolUpdate };
