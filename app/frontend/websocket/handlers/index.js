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
const { handleManualTradeAllSymbols } = require('./manual-trade-all-symbols');
const { handleCancelOrder } = require('./cancel-order');
const { handleDustTransferGet } = require('./dust-transfer-get');
const { handleDustTransferExecute } = require('./dust-transfer-execute');

module.exports = {
  handleLatest,
  handleSettingUpdate,
  handleSymbolUpdateLastBuyPrice,
  handleSymbolDelete,
  handleSymbolSettingUpdate,
  handleSymbolSettingDelete,
  handleSymbolEnableAction,
  handleManualTrade,
  handleManualTradeAllSymbols,
  handleCancelOrder,
  handleDustTransferGet,
  handleDustTransferExecute
};
