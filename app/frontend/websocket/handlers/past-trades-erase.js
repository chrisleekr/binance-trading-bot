
const { PubSub } = require('../../../helpers');
const {
  erasePastTrades
} = require('../../../cronjob/trailingTradeHelper/configuration');

const handlePastTradesErase = async (logger, ws, payload) => {
  logger.info({ payload }, 'Start resetting past trades');

  try {
    await erasePastTrades(logger);

    PubSub.publish('frontend-notification', {
      type: 'success',
      title: `Past trades erased successfully.`
    });

    ws.send(JSON.stringify({ result: true, type: 'past-trades-erase-successful' }));
  } catch {
    PubSub.publish('frontend-notification', {
      type: 'error',
      title: `Cant delete past trades. Something is wrong.`
    });
  }


};

module.exports = { handlePastTradesErase };
