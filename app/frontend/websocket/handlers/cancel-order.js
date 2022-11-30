const moment = require('moment');
const {
  saveOverrideAction
} = require('../../../cronjob/trailingTradeHelper/common');
const queue = require('../../../cronjob/trailingTradeHelper/queue');

const handleCancelOrder = async (logger, ws, payload) => {
  logger.info({ payload }, 'Start cancel order');

  const {
    data: { symbol, order }
  } = payload;

  const { side } = order;
  await saveOverrideAction(
    logger,
    symbol,
    {
      action: 'cancel-order',
      order,
      actionAt: moment().toISOString(),
      triggeredBy: 'user'
    },
    `Cancelling the ${side.toLowerCase()} order action has been received. Wait for cancelling the order.`
  );

  queue.executeFor(logger, symbol);

  ws.send(
    JSON.stringify({
      result: true,
      type: 'cancel-order-result',
      message: `Cancelling the ${side.toLowerCase()} order action has been received.`
    })
  );
};

module.exports = { handleCancelOrder };
