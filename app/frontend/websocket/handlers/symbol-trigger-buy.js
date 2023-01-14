const _ = require('lodash');
const moment = require('moment');
const {
  saveOverrideAction
} = require('../../../cronjob/trailingTradeHelper/common');
const queue = require('../../../cronjob/trailingTradeHelper/queue');
const { executeTrailingTrade } = require('../../../cronjob/index');

const handleSymbolTriggerBuy = async (logger, ws, payload) => {
  logger.info({ payload }, 'Start symbol trigger buy');

  const { data: symbolInfo } = payload;

  const { symbol } = symbolInfo;

  const saveOverrideActionFn = async () => {
    await saveOverrideAction(
      logger,
      symbol,
      {
        action: 'buy',
        actionAt: moment().toISOString(),
        triggeredBy: 'user',
        notify: true,
        // For triggering buy action must execute. So don't check TradingView recommendation.
        checkTradingView: false
      },
      'The buy order received by the bot. Wait for placing the order.'
    );
  };

  queue.execute(logger, symbol, {
    correlationId: _.get(logger, 'fields.correlationId', ''),
    preprocessFn: saveOverrideActionFn,
    processFn: executeTrailingTrade
  });

  ws.send(JSON.stringify({ result: true, type: 'symbol-trigger-buy-result' }));
};

module.exports = { handleSymbolTriggerBuy };
