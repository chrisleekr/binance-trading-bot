const moment = require('moment');
const {
  saveOverrideIndicatorAction
} = require('../../../cronjob/trailingTradeHelper/common');

const handleDustTransferExecute = async (logger, ws, payload) => {
  logger.info({ payload }, 'Start dust transfer execute');

  const {
    data: { dustTransfer }
  } = payload;

  await saveOverrideIndicatorAction(
    logger,
    'global',
    {
      action: 'dust-transfer',
      params: dustTransfer,
      actionAt: moment().format(),
      triggeredBy: 'user'
    },
    'The dust transfer request received by the bot. Wait for executing the dust transfer.'
  );

  ws.send(
    JSON.stringify({
      result: true,
      type: 'dust-transfer-execute-result',
      message: 'The dust transfer request received.'
    })
  );
};

module.exports = { handleDustTransferExecute };
