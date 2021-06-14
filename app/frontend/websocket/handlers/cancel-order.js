const moment = require('moment');
const { cache, PubSub } = require('../../../helpers');

const handleCancelOrder = async (logger, ws, payload) => {
  logger.info({ payload }, 'Start cancel order');

  const {
    data: { symbol, order }
  } = payload;

  await cache.hset(
    'trailing-trade-override',
    `${symbol}`,
    JSON.stringify({
      action: 'cancel-order',
      order,
      actionAt: moment()
    })
  );

  PubSub.publish('frontend-notification', {
    type: 'info',
    title:
      'Cancelling the order action has been received. Wait for cancelling the order.'
  });

  ws.send(
    JSON.stringify({
      result: true,
      type: 'cancel-order-result',
      message: 'Cancelling the order action has been received.'
    })
  );
};

module.exports = { handleCancelOrder };
