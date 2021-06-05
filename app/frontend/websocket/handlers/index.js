const { handleLatest } = require('./latest');
const { handleSettingUpdate } = require('./setting-update');
const {
  handleSymbolUpdateLastBuyPrice
} = require('./symbol-update-last-buy-price');
const { handleSymbolDelete } = require('./symbol-delete');
const { handleSymbolSettingUpdate } = require('./symbol-setting-update');
const { handleSymbolSettingDelete } = require('./symbol-setting-delete');
const { handleSymbolEnableAction } = require('./symbol-enable-action');
const { handleManualTrade } = require('./manual-trade');
const { handleCancelOrder } = require('./cancel-order');

module.exports = {
  handleLatest,
  handleSettingUpdate,
  handleSymbolUpdateLastBuyPrice,
  handleSymbolDelete,
  handleSymbolSettingUpdate,
  handleSymbolSettingDelete,
  handleSymbolEnableAction,
  handleManualTrade,
  handleCancelOrder
};
