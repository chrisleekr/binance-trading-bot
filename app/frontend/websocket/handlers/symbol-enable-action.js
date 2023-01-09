const _ = require('lodash');
const {
  deleteDisableAction
} = require('../../../cronjob/trailingTradeHelper/common');
const queue = require('../../../cronjob/trailingTradeHelper/queue');

const handleSymbolEnableAction = async (logger, ws, payload) => {
  logger.info({ payload }, 'Start symbol enable action');

  const { data: symbolInfo } = payload;

  const { symbol } = symbolInfo;

  const deleteDisableActionFn = async () => {
    await deleteDisableAction(logger, symbol);
  };

  queue.execute(
    logger,
    symbol,
    {
      start: true,
      preprocessFn: deleteDisableActionFn,
      execute: true,
      finish: true
    },
    {
      correlationId: _.get(logger, 'fields.correlationId', '')
    }
  );

  ws.send(
    JSON.stringify({ result: true, type: 'symbol-enable-action-result' })
  );
};

module.exports = { handleSymbolEnableAction };
