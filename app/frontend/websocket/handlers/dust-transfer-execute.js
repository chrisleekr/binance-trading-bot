const moment = require('moment');
const { cache, PubSub } = require('../../../helpers');

const handleDustTransferExecute = async (logger, ws, payload) => {
  logger.info({ payload }, 'Start dust transfer execute');

  const {
    data: { dustTransfer }
  } = payload;

  await cache.hset(
    'trailing-trade-indicator-override',
    'global',
    JSON.stringify({
      action: 'dust-transfer',
      params: dustTransfer,
      actionAt: moment()
    })
  );

  PubSub.publish('frontend-notification', {
    type: 'info',
    title:
      'The dust transfer request received by the bot. Wait for executing the dust transfer.'
  });

  ws.send(
    JSON.stringify({
      result: true,
      type: 'dust-transfer-execute-result',
      message: 'The dust transfer request received.'
    })
  );
};

module.exports = { handleDustTransferExecute };
