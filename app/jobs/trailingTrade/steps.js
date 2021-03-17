const { execute: getNextSymbol } = require('./step/get-next-symbol');
const {
  execute: getGlobalConfiguration
} = require('./step/get-global-configuration');
const { execute: getExchangeSymbols } = require('./step/get-exchange-symbols');
const {
  execute: getSymbolConfiguration
} = require('./step/get-symbol-configuration');
const { execute: getSymbolInfo } = require('./step/get-symbol-info');
const { execute: getAccountInfo } = require('./step/get-account-info');
const { execute: getOpenOrders } = require('./step/get-open-orders');
const { execute: getIndicators } = require('./step/get-indicators');
const { execute: handleOpenOrders } = require('./step/handle-open-orders');
const { execute: determineAction } = require('./step/determine-action');
const { execute: placeBuyOrder } = require('./step/place-buy-order');
const { execute: placeSellOrder } = require('./step/place-sell-order');
const { execute: removeLastBuyPrice } = require('./step/remove-last-buy-price');
const { execute: saveDataToCache } = require('./step/save-data-to-cache');

module.exports = {
  getNextSymbol,
  getGlobalConfiguration,
  getExchangeSymbols,
  getSymbolConfiguration,
  getSymbolInfo,
  getAccountInfo,
  getOpenOrders,
  getIndicators,
  handleOpenOrders,
  determineAction,
  placeBuyOrder,
  placeSellOrder,
  removeLastBuyPrice,
  saveDataToCache
};
