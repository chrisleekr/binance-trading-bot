const moment = require('moment');
const {
  saveOverrideAction
} = require('../../../cronjob/trailingTradeHelper/common');

const handleSymbolTriggerSell = async (logger, ws, payload) => {
  logger.info({ payload }, 'Start symbol trigger sell');

  const { data: symbolInfo } = payload;

  const { symbol } = symbolInfo;

  await saveOverrideAction(
    logger,
    symbol,
    {
      action: 'sell',
      actionAt: moment().format(),
      triggeredBy: 'user'
    },
    'The sell order received by the bot. Wait for placing the order.'
  );

  ws.send(JSON.stringify({ result: true, type: 'symbol-trigger-sell-result' }));
};

module.exports = { handleSymbolTriggerSell };
