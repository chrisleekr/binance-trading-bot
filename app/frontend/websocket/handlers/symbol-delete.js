const { cache, mongo } = require('../../../helpers');

const handleSymbolDelete = async (logger, ws, payload) => {
  logger.info({ payload }, 'Start symbol delete');

  const { data } = payload;
  const { symbolInfo } = data;
  const { symbol } = symbolInfo;

  const cacheValues = await cache.hgetall(
    'trailing-trade-symbols:',
    `trailing-trade-symbols:${symbol}*`
  );

  await Promise.all(
    Object.keys(cacheValues).map(key =>
      cache.hdel('trailing-trade-symbols', key)
    )
  );

  [`${symbol}-last-buy-price`].forEach(async key => {
    await mongo.deleteOne(logger, 'trailing-trade-symbols', { key });
  });

  await mongo.deleteOne(logger, 'trailing-trade-cache', { symbol });

  ws.send(JSON.stringify({ result: true, type: 'symbol-delete-result' }));
};

module.exports = { handleSymbolDelete };
