const {
  deleteSymbolGridTrade
} = require('../../../cronjob/trailingTradeHelper/configuration');

const handleSymbolGridTradeDelete = async (logger, ws, payload) => {
  logger.info({ payload }, 'Start grid trade delete');

  const { data: symbolInfo } = payload;

  const { symbol } = symbolInfo;

  await deleteSymbolGridTrade(logger, symbol);

  ws.send(
    JSON.stringify({ result: true, type: 'symbol-grid-trade-delete-result' })
  );
};

module.exports = { handleSymbolGridTradeDelete };
