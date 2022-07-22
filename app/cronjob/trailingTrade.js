const config = require('config');

const {
  getAccountInfo,
  isSymbolLocked
} = require('./trailingTradeHelper/common');

const {
  getSymbolConfiguration,
  getSymbolInfo,
  getOverrideAction,
  ensureManualOrder,
  ensureGridTradeOrderExecuted,
  getBalances,
  getOpenOrders,
  getIndicators,
  handleOpenOrders,
  determineAction,
  placeManualTrade,
  cancelOrder,
  placeBuyOrder,
  placeSellOrder,
  placeSellStopLossOrder,
  removeLastBuyPrice,
  saveDataToCache
} = require('./trailingTrade/steps');

const execute = async (rawLogger, symbol) => {
  const logger = rawLogger.child({ jobName: 'trailingTrade' });

  // Retrieve account info from cache
  const accountInfo = await getAccountInfo(logger);

  // Retrieve feature toggles
  const featureToggle = config.get('featureToggle');

  logger.info({ debug: true, symbol }, '▶ TrailingTrade: Start process...');

  // Check if the symbol is locked, if it is locked, it means the symbol is still processing.
  const isLocked = await isSymbolLocked(logger, symbol);

  // Define skeleton of data structure
  let data = {
    symbol,
    isLocked,
    featureToggle,
    lastCandle: {},
    accountInfo,
    symbolConfiguration: {},
    indicators: {},
    symbolInfo: {},
    openOrders: [],
    action: 'not-determined',
    baseAssetBalance: {},
    quoteAssetBalance: {},
    buy: {},
    sell: {},
    order: {},
    canDisable: true,
    saveToCache: true
  };

  // eslint-disable-next-line no-restricted-syntax
  for (const { stepName, stepFunc } of [
    {
      stepName: 'get-symbol-configuration',
      stepFunc: getSymbolConfiguration
    },
    {
      stepName: 'get-symbol-info',
      stepFunc: getSymbolInfo
    },
    {
      stepName: 'ensure-manual-order',
      stepFunc: ensureManualOrder
    },
    {
      stepName: 'ensure-grid-trade-order-executed',
      stepFunc: ensureGridTradeOrderExecuted
    },
    {
      stepName: 'get-balances',
      stepFunc: getBalances
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
      stepName: 'get-override-action',
      stepFunc: getOverrideAction
    },
    {
      stepName: 'handle-open-orders',
      stepFunc: handleOpenOrders
    },
    // In case account information is updated, get balance again.
    {
      stepName: 'get-balances',
      stepFunc: getBalances
    },
    {
      stepName: 'determine-action',
      stepFunc: determineAction
    },
    {
      stepName: 'place-manual-order',
      stepFunc: placeManualTrade
    },
    {
      stepName: 'cancel-order',
      stepFunc: cancelOrder
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
      stepName: 'place-sell-stop-loss-order',
      stepFunc: placeSellStopLossOrder
    },
    // In case account information is updated, get balance again.
    {
      stepName: 'get-balances',
      stepFunc: getBalances
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

  logger.info({ symbol }, '⏹ TrailingTrade: Finish process (Debug)...');

  logger.info({ symbol, data }, 'TrailingTrade: Finish process...');
};

module.exports = { execute };
