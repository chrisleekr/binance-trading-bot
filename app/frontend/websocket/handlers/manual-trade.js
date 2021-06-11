const moment = require('moment');
const { cache, PubSub } = require('../../../helpers');

const handleManualTrade = async (logger, ws, payload) => {
  logger.info({ payload }, 'Start manual trade');

  const {
    data: { symbol, order }
  } = payload;

  await cache.hset(
    'trailing-trade-override',
    `${symbol}`,
    JSON.stringify({
      action: 'manual-trade',
      order,
      actionAt: moment()
    })
  );

  PubSub.publish('frontend-notification', {
    type: 'info',
    title: 'The order received by the bot. Wait for placing the order.'
  });

  ws.send(
    JSON.stringify({
      result: true,
      type: 'manual-trade-result',
      message: 'The order has been received.'
    })
  );
};

module.exports = { handleManualTrade };
