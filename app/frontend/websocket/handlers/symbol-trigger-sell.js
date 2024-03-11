const _ = require('lodash');
const moment = require('moment');
const {
  saveOverrideAction
} = require('../../../cronjob/trailingTradeHelper/common');
const queue = require('../../../cronjob/trailingTradeHelper/queue');
const { executeTrailingTrade } = require('../../../cronjob/index');

const handleSymbolTriggerSell = async (logger, ws, payload) => {
  logger.info({ payload }, 'Start symbol trigger sell');

  const { data: symbolInfo } = payload;

  const { symbol } = symbolInfo;

  const saveOverrideActionFn = async () => {
    await saveOverrideAction(
      logger,
      symbol,
      {
        action: 'sell',
        actionAt: moment().toISOString(),
        triggeredBy: 'user'
      },
      'The sell order received by the bot. Wait for placing the order.'
    );
  };

  queue.execute(logger, symbol, {
    correlationId: _.get(logger, 'fields.correlationId', ''),
    preprocessFn: saveOverrideActionFn,
    processFn: executeTrailingTrade
  });

  ws.send(JSON.stringify({ result: true, type: 'symbol-trigger-sell-result' }));
};

module.exports = { handleSymbolTriggerSell };
