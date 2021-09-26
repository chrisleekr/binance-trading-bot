const moment = require('moment');
const {
  saveOverrideAction
} = require('../../../cronjob/trailingTradeHelper/common');

const handleCancelOrder = async (logger, ws, payload) => {
  logger.info({ payload }, 'Start cancel order');

  const {
    data: { symbol, order }
  } = payload;

  await saveOverrideAction(
    logger,
    symbol,
    {
      action: 'cancel-order',
      order,
      actionAt: moment().format(),
      triggeredBy: 'user'
    },
    'Cancelling the order action has been received. Wait for cancelling the order.'
  );

  ws.send(
    JSON.stringify({
      result: true,
      type: 'cancel-order-result',
      message: 'Cancelling the order action has been received.'
    })
  );
};

module.exports = { handleCancelOrder };
