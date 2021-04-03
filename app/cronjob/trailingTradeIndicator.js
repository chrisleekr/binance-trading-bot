const {
  getGlobalConfiguration,
  getNextSymbol,
  getSymbolConfiguration,
  getAccountInfo,
  getIndicators,
  getOpenOrders,
  saveDataToCache
} = require('./trailingTradeIndicator/steps');
const { slack } = require('../helpers');

const execute = async logger => {
  // Define sekeleton of data structure
  let data = {
    globalConfiguration: {},
    symbol: null,
    symbolConfiguration: {},
    accountInfo: {},
    indicators: {},
    openOrders: []
  };

  try {
    data = await getGlobalConfiguration(logger, data);
    data = await getNextSymbol(logger, data);

    // eslint-disable-next-line no-restricted-syntax
    for (const { stepName, stepFunc } of [
      {
        stepName: 'get-symbol-configuration',
        stepFunc: getSymbolConfiguration
      },
      {
        stepName: 'get-account-info',
        stepFunc: getAccountInfo
      },
      {
        stepName: 'get-indicators',
        stepFunc: getIndicators
      },
      {
        // Note that open orders for all symbols cannot exceed 40 request per minute.
        // Hence, this must be executed every 2 seconds.
        // After placing buy/sell orders, the bot will retrieve symbol open orders which can request every second.
        stepName: 'get-open-orders',
        stepFunc: getOpenOrders
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

    logger.info(
      { symbol: data.symbol, data },
      'Trade: Finish trailing trade indicator process...'
    );
  } catch (err) {
    logger.error(
      { symbol: data.symbol, err, debug: true },
      `Execution failed.`
    );
    if (
      err.code === -1001 ||
      err.code === -1021 || // Timestamp for this request is outside of the recvWindow
      err.code === 'ECONNRESET' ||
      err.code === 'ECONNREFUSED'
    ) {
      // Let's silent for internal server error or assumed temporary errors
    } else {
      slack.sendMessage(
        `Execution failed\nCode: ${err.code}\nMessage:\`\`\`${err.message}\`\`\`Stack:\`\`\`${err.stack}\`\`\``
      );
    }
  }
};

module.exports = { execute };
