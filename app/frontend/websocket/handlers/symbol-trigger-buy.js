const moment = require('moment');
const {
  saveOverrideAction
} = require('../../../cronjob/trailingTradeHelper/common');

const handleSymbolTriggerBuy = async (logger, ws, payload) => {
  logger.info({ payload }, 'Start symbol trigger buy');

  const { data: symbolInfo } = payload;

  const { symbol } = symbolInfo;

  await saveOverrideAction(
    logger,
    symbol,
    {
      action: 'buy',
      actionAt: moment().format(),
      triggeredBy: 'user',
      notify: true,
      // For triggering buy action must execute. So don't check TradingView recommendation.
      checkTradingView: false
    },
    'The buy order received by the bot. Wait for placing the order.'
  );

  ws.send(JSON.stringify({ result: true, type: 'symbol-trigger-buy-result' }));
};

module.exports = { handleSymbolTriggerBuy };
