const {
  deleteDisableAction
} = require('../../../cronjob/trailingTradeHelper/common');
const queue = require('../../../cronjob/trailingTradeHelper/queue');

const handleSymbolEnableAction = async (logger, ws, payload) => {
  logger.info({ payload }, 'Start symbol enable action');

  const { data: symbolInfo } = payload;

  const { symbol } = symbolInfo;

  await deleteDisableAction(logger, symbol);

  queue.executeFor(logger, symbol);

  ws.send(
    JSON.stringify({ result: true, type: 'symbol-enable-action-result' })
  );
};

module.exports = { handleSymbolEnableAction };
