const {
  execute: getSymbolConfiguration
} = require('./step/get-symbol-configuration');
const { execute: getSymbolInfo } = require('./step/get-symbol-info');
const { execute: getBalances } = require('./step/get-balances');
const { execute: ensureOrderPlaced } = require('./step/ensure-order-placed');
const { execute: getOpenOrders } = require('./step/get-open-orders');
const { execute: getIndicators } = require('./step/get-indicators');
const { execute: handleOpenOrders } = require('./step/handle-open-orders');
const { execute: determineAction } = require('./step/determine-action');
const { execute: placeBuyOrder } = require('./step/place-buy-order');
const { execute: placeSellOrder } = require('./step/place-sell-order');
const {
  execute: placeSellStopLossOrder
} = require('./step/place-sell-stop-loss-order');
const { execute: removeLastBuyPrice } = require('./step/remove-last-buy-price');
const { execute: saveDataToCache } = require('./step/save-data-to-cache');

module.exports = {
  getSymbolConfiguration,
  getSymbolInfo,
  getBalances,
  ensureOrderPlaced,
  getOpenOrders,
  getIndicators,
  handleOpenOrders,
  determineAction,
  placeBuyOrder,
  placeSellOrder,
  placeSellStopLossOrder,
  removeLastBuyPrice,
  saveDataToCache
};
