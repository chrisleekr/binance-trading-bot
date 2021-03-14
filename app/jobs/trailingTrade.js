const {
  getGlobalConfiguration,
  getNextSymbol,
  getExchangeSymbols,
  getSymbolConfiguration,
  getAccountInfo,
  getIndicators,
  getOpenOrders,
  handleOpenOrders,
  determineAction,
  placeBuyOrder,
  placeSellOrder,
  removeLastBuyPrice,
  saveDataToCache
} = require('./trailingTrade/steps');
const { slack } = require('../helpers');

const execute = async logger => {
  // Define sekeleton of data structure
  let data = {
    globalConfiguration: {},
    symbol: null,
    symbolConfiguration: {},
    accountInfo: {},
    indicators: {},
    symbolInfo: {},
    openOrders: [],
    action: 'not-determined',
    baseAssetBalance: {},
    quoteAssetBalance: {},
    buy: {},
    sell: {}
  };

  try {
    data = await getGlobalConfiguration(logger, data);
    data = await getNextSymbol(logger, data);

    // eslint-disable-next-line no-restricted-syntax
    for (const { stepName, stepFunc } of [
      { stepName: 'get-exchange-symbol', stepFunc: getExchangeSymbols },
      {
        stepName: 'get-symbol-configuration',
        stepFunc: getSymbolConfiguration
      },
      {
        stepName: 'get-account-info',
        stepFunc: getAccountInfo
      },
      {
        stepName: 'get-open-orders',
        stepFunc: getOpenOrders
      },
      {
        stepName: 'get-indicators',
        stepFunc: getIndicators
      },
      {
        stepName: 'handle-open-orders',
        stepFunc: handleOpenOrders
      },
      {
        stepName: 'determine-action',
        stepFunc: determineAction
      },
      {
        stepName: 'place-buy-order',
        stepFunc: placeBuyOrder
      },
      {
        stepName: 'place-sell-order',
        stepFunc: placeSellOrder
      },
      {
        stepName: 'remove-last-buy-price',
        stepFunc: removeLastBuyPrice
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
      'Trade: Finish trailing trade process...'
    );
  } catch (err) {
    logger.error({ symbol: data.symbol, err }, `Execution failed.`);
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
