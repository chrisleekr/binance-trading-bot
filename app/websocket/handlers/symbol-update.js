const { mongo } = require('../../helpers');

const handleSymbolUpdate = async (logger, ws, payload) => {
  logger.info({ payload }, 'Start symbol update');

  const { data: symbolInfo } = payload;

  // Update last-buy-price
  const { symbol } = symbolInfo;

  const { lastBuyPrice } = symbolInfo.sell;

  await mongo.upsertOne(
    logger,
    'simple-stop-chaser-symbols',
    { key: `${symbol}-last-buy-price` },
    {
      key: `${symbol}-last-buy-price`,
      lastBuyPrice
    }
  );

  ws.send(JSON.stringify({ result: true, type: 'symbol-update-result' }));
};

module.exports = { handleSymbolUpdate };
