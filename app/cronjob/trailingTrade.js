const {
  getGlobalConfiguration
} = require('./trailingTradeHelper/configuration');

const {
  cacheExchangeSymbols,
  getAccountInfo,
  lockSymbol,
  isSymbolLocked,
  unlockSymbol
} = require('./trailingTradeHelper/common');

const {
  getSymbolConfiguration,
  getSymbolInfo,
  getBalances,
  getOpenOrders,
  getIndicators,
  handleOpenOrders,
  determineAction,
  placeBuyOrder,
  placeSellOrder,
  removeLastBuyPrice,
  saveDataToCache
} = require('./trailingTrade/steps');
const { slack } = require('../helpers');

const execute = async logger => {
  try {
    // Retrieve global configuration
    const globalConfiguration = await getGlobalConfiguration(logger);

    // Retrieve exchange symbols and cache it
    await cacheExchangeSymbols(logger, globalConfiguration);

    // Retrieve account info from cache
    const accountInfo = await getAccountInfo(logger);

    await Promise.all(
      globalConfiguration.symbols.map(async symbol => {
        logger.info({ debug: true, symbol }, 'TrailingTrade: Start process...');

        // Check if the symbol is locked, if it is locked, it means the symbol is still processing.
        const isLocked = await isSymbolLocked(logger, symbol);

        if (isLocked === false) {
          await lockSymbol(logger, symbol);
        }

        // Define sekeleton of data structure
        let data = {
          symbol,
          isLocked,
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
            stepName: 'place-buy-order',
            stepFunc: placeBuyOrder
          },
          {
            stepName: 'place-sell-order',
            stepFunc: placeSellOrder
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

        // Unlock symbol for processing if it is not locked by another process
        if (isLocked === false) {
          await unlockSymbol(logger, symbol);
        }

        logger.info(
          { debug: true, symbol },
          'TrailingTrade: Finish process (Debug)...'
        );
        logger.info({ symbol, data }, 'TrailingTrade: Finish process...');
      })
    );
  } catch (err) {
    logger.error(
      { err, errorCode: err.code, debug: true },
      `Execution failed.`
    );
    if (
      err.code === -1001 ||
      err.code === -1021 || // Timestamp for this request is outside of the recvWindow
      err.code === 'ECONNRESET' ||
      err.code === 'ECONNREFUSED' ||
      err.message.includes('redlock') // For the redlock fail
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
