const moment = require('moment');
const { cache, PubSub } = require('../../../helpers');

const handleSymbolTriggerSell = async (logger, ws, payload) => {
  logger.info({ payload }, 'Start symbol trigger sell');

  const { data: symbolInfo } = payload;

  const { symbol } = symbolInfo;

  await cache.hset(
    'trailing-trade-override',
    `${symbol}`,
    JSON.stringify({
      action: 'sell',
      actionAt: moment()
    })
  );

  PubSub.publish('frontend-notification', {
    type: 'info',
    title: 'The order received by the bot. Wait for placing the order.'
  });

  ws.send(JSON.stringify({ result: true, type: 'symbol-trigger-sell-result' }));
};

module.exports = { handleSymbolTriggerSell };
