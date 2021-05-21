const { execute: getNextSymbol } = require('./step/get-next-symbol');
const {
  execute: getGlobalConfiguration
} = require('./step/get-global-configuration');
const {
  execute: getSymbolConfiguration
} = require('./step/get-symbol-configuration');
const { execute: getAccountInfo } = require('./step/get-account-info');
const { execute: getIndicators } = require('./step/get-indicators');
const { execute: getOpenOrders } = require('./step/get-open-orders');
const { execute: saveDataToCache } = require('./step/save-data-to-cache');

module.exports = {
  getGlobalConfiguration,
  getNextSymbol,
  getSymbolConfiguration,
  getAccountInfo,
  getIndicators,
  getOpenOrders,
  saveDataToCache
};
