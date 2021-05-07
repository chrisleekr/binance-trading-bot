const {
  deleteDisableActionByStopLoss
} = require('../../../cronjob/trailingTradeHelper/common');

const handleSymbolEnableAction = async (logger, ws, payload) => {
  logger.info({ payload }, 'Start symbol enable action');

  const { data: symbolInfo } = payload;

  const { symbol } = symbolInfo;

  await deleteDisableActionByStopLoss(logger, symbol);

  ws.send(
    JSON.stringify({ result: true, type: 'symbol-enable-action-result' })
  );
};

module.exports = { handleSymbolEnableAction };
