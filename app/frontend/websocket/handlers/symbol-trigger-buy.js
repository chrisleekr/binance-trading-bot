const moment = require('moment');
const { cache, PubSub } = require('../../../helpers');

const handleSymbolTriggerBuy = async (logger, ws, payload) => {
  logger.info({ payload }, 'Start symbol trigger buy');

  const { data: symbolInfo } = payload;

  const { symbol } = symbolInfo;

  await cache.hset(
    'trailing-trade-override',
    `${symbol}`,
    JSON.stringify({
      action: 'buy',
      actionAt: moment()
    })
  );

  PubSub.publish('frontend-notification', {
    type: 'info',
    title: 'The order received by the bot. Wait for placing the order.'
  });

  ws.send(JSON.stringify({ result: true, type: 'symbol-trigger-buy-result' }));
};

module.exports = { handleSymbolTriggerBuy };
