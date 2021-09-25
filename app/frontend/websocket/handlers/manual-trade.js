const moment = require('moment');
const {
  saveOverrideAction
} = require('../../../cronjob/trailingTradeHelper/common');

const handleManualTrade = async (logger, ws, payload) => {
  logger.info({ payload }, 'Start manual trade');

  const {
    data: { symbol, order }
  } = payload;

  await saveOverrideAction(
    logger,
    symbol,
    {
      action: 'manual-trade',
      order,
      actionAt: moment().format(),
      triggeredBy: 'user'
    },
    'The manual order received by the bot. Wait for placing the order.'
  );

  ws.send(
    JSON.stringify({
      result: true,
      type: 'manual-trade-result',
      message: 'The order has been received.'
    })
  );
};

module.exports = { handleManualTrade };
