const { cache, mongo } = require('../../helpers');

const handleSymbolDelete = async (logger, ws, payload) => {
  logger.info({ payload }, 'Start symbol delete');

  const { data } = payload;
  const { symbolInfo } = data;
  const { symbol } = symbolInfo;

  const cacheValues = await cache.hgetall('simple-stop-chaser-symbols');

  Object.keys(cacheValues).forEach(async key => {
    if (key.startsWith(symbol)) {
      await cache.hdel('simple-stop-chaser-symbols', key);
    }
  });

  [`${symbol}-last-buy-price`].forEach(async key => {
    await mongo.deleteOne(logger, 'simple-stop-chaser-symbols', { key });
  });

  ws.send(JSON.stringify({ result: true, type: 'symbol-delete-result' }));
};

module.exports = { handleSymbolDelete };
