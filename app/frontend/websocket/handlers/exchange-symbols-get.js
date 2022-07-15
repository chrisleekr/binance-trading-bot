const { cache } = require('../../../helpers');

const handleExchangeSymbolsGet = async (_logger, ws, _payload) => {
  // Get cached exchange symbols
  const exchangeSymbols =
    JSON.parse(await cache.hget('trailing-trade-common', 'exchange-symbols')) ||
    {};

  ws.send(
    JSON.stringify({
      result: true,
      type: 'exchange-symbols-get-result',
      exchangeSymbols
    })
  );
};

module.exports = { handleExchangeSymbolsGet };
