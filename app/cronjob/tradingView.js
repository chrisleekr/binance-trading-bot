const {
  getGlobalConfiguration,
  getTradingView
} = require('./trailingTradeIndicator/steps');
const { errorHandlerWrapper } = require('../error-handler');

const execute = async logger => {
  // Define sekeleton of data structure
  let data = {
    globalConfiguration: {},
    tradingView: {}
  };

  await errorHandlerWrapper(logger, 'TradingView', async () => {
    data = await getGlobalConfiguration(logger, data);

    // eslint-disable-next-line no-restricted-syntax
    for (const { stepName, stepFunc } of [
      {
        stepName: 'get-tradingview',
        stepFunc: getTradingView
      }
    ]) {
      const stepLogger = logger.child({ stepName, symbol: data.symbol });

      stepLogger.info({ data }, `Start step - ${stepName}`);

      // eslint-disable-next-line no-await-in-loop
      data = await stepFunc(stepLogger, data);
      stepLogger.info({ data }, `Finish step - ${stepName}`);
    }

    logger.info({ data }, 'TradingView: Finish process...');
  });
};

module.exports = { execute };
