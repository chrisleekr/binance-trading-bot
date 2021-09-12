const { execute: getNextSymbol } = require('./step/get-next-symbol');
const {
  execute: getGlobalConfiguration
} = require('./step/get-global-configuration');
const {
  execute: getSymbolConfiguration
} = require('./step/get-symbol-configuration');
const { execute: getSymbolInfo } = require('./step/get-symbol-info');
const { execute: getOverrideAction } = require('./step/get-override-action');
const { execute: getAccountInfo } = require('./step/get-account-info');
const { execute: getIndicators } = require('./step/get-indicators');
const { execute: getOpenOrders } = require('./step/get-open-orders');
const {
  execute: executeDustTransfer
} = require('./step/execute-dust-transfer');
const { execute: getClosedTrades } = require('./step/get-closed-trades');
const { execute: getOrderStats } = require('./step/get-order-stats');
const { execute: saveDataToCache } = require('./step/save-data-to-cache');

module.exports = {
  getNextSymbol,
  getGlobalConfiguration,
  getSymbolConfiguration,
  getSymbolInfo,
  getOverrideAction,
  getAccountInfo,
  getIndicators,
  getOpenOrders,
  executeDustTransfer,
  getClosedTrades,
  getOrderStats,
  saveDataToCache
};
