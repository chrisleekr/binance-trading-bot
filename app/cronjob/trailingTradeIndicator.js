const config = require('config');
const queue = require('./trailingTradeHelper/queue');

const { getAPILimit } = require('./trailingTradeHelper/common');

const {
  getGlobalConfiguration,
  getNextSymbol,
  getSymbolConfiguration,
  getSymbolInfo,
  getOverrideAction,
  executeDustTransfer,
  getClosedTrades,
  getOrderStats,
  getTradingView,
  saveDataToCache
} = require('./trailingTradeIndicator/steps');
const { errorHandlerWrapper } = require('../error-handler');

const execute = async logger => {
  // Retrieve feature toggles
  const featureToggle = config.get('featureToggle');

  // Define sekeleton of data structure
  let data = {
    action: 'not-determined',
    featureToggle,
    globalConfiguration: {},
    symbol: null,
    symbolConfiguration: {},
    symbolInfo: {},
    overrideParams: {},
    quoteAssetStats: {},
    tradingView: {},
    apiLimit: { start: getAPILimit(logger), end: null }
  };

  await errorHandlerWrapper(logger, 'Trailing Trade Indicator', async () => {
    data = await getGlobalConfiguration(logger, data);
    data = await getNextSymbol(logger, data);

    const { symbol } = data;
    logger.info(
      { debug: true, symbol },
      '▶ TrailingTradeIndicator: Start process...'
    );

    const executeTrailingTradeIndicatorFn = async () => {
      // eslint-disable-next-line no-restricted-syntax
      for (const { stepName, stepFunc } of [
        {
          stepName: 'get-symbol-configuration',
          stepFunc: getSymbolConfiguration
        },
        {
          stepName: 'get-override-action',
          stepFunc: getOverrideAction
        },
        {
          stepName: 'execute-dust-transfer',
          stepFunc: executeDustTransfer
        },
        {
          stepName: 'get-symbol-info',
          stepFunc: getSymbolInfo
        },
        {
          stepName: 'get-closed-trades',
          stepFunc: getClosedTrades
        },
        {
          stepName: 'get-order-stats',
          stepFunc: getOrderStats
        },
        {
          stepName: 'get-tradingview',
          stepFunc: getTradingView
        },
        {
          stepName: 'save-data-to-cache',
          stepFunc: saveDataToCache
        }
      ]) {
        const stepLogger = logger.child({ stepName, symbol: data.symbol });

        stepLogger.info({ data }, `Start step - ${stepName}`);

        // eslint-disable-next-line no-await-in-loop
        data = await stepFunc(stepLogger, data);
        stepLogger.info({ data }, `Finish step - ${stepName}`);
      }
    };

    // Prepare job for processing
    await queue.execute(logger, symbol, {
      processFn: executeTrailingTradeIndicatorFn
    });

    data.apiLimit.end = getAPILimit(logger);

    logger.info(
      { debug: true, symbol },
      '⏹ TrailingTradeIndicator: Finish process (Debug)...'
    );

    logger.info({ symbol, data }, 'TrailingTradeIndicator: Finish process...');
  });
};

module.exports = { execute };
