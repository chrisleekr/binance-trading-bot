const config = require('config');

const {
  lockSymbol,
  isSymbolLocked,
  unlockSymbol,
  getAPILimit
} = require('./trailingTradeHelper/common');

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

    // Check if the symbol is locked, if it is locked, it means the symbol is still trading.
    if ((await isSymbolLocked(logger, symbol)) === true) {
      logger.info(
        { debug: true, symbol },
        '⏯ TrailingTradeIndicator: Skip process as the symbol is currently locked.'
      );
      return;
    }
    // Lock symbol for processing
    await lockSymbol(logger, symbol);

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

    // Unlock symbol for processing
    await unlockSymbol(logger, symbol);

    data.apiLimit.end = getAPILimit(logger);

    logger.info(
      { debug: true, symbol },
      '⏹ TrailingTradeIndicator: Finish process (Debug)...'
    );

    logger.info({ symbol, data }, 'TrailingTradeIndicator: Finish process...');
  });
};

module.exports = { execute };
