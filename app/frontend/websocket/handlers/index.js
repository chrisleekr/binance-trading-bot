const { handleLatest } = require('./latest');
const { handleDisconnect } = require('./disconnect');
const { handleSettingUpdate } = require('./setting-update');
const {
  handleSymbolUpdateLastBuyPrice
} = require('./symbol-update-last-buy-price');
const { handleSymbolBackTest } = require('./symbol-backtest');
const { handleSymbolDelete } = require('./symbol-delete');
const { handleResetFactorySettings } = require('./reset-factory-settings');
const { handleSymbolSettingUpdate } = require('./symbol-setting-update');
const { handleSymbolSettingDelete } = require('./symbol-setting-delete');
const { handleSymbolEnableAction } = require('./symbol-enable-action');
const { handleManualTrade } = require('./manual-trade');
const { handleManualTradeAllSymbols } = require('./manual-trade-all-symbols');
const { handleCancelOrder } = require('./cancel-order');
const { handleDustTransferGet } = require('./dust-transfer-get');
const { handleDustTransferExecute } = require('./dust-transfer-execute');
const { handlePassword } = require('./handle-password');
const { handlePastTradesErase } = require('./past-trades-erase');

module.exports = {
  handleLatest,
  handleDisconnect,
  handleSettingUpdate,
  handleSymbolUpdateLastBuyPrice,
  handleSymbolBackTest,
  handleSymbolDelete,
  handlePastTradesErase,
  handleResetFactorySettings,
  handleSymbolSettingUpdate,
  handleSymbolSettingDelete,
  handleSymbolEnableAction,
  handleManualTrade,
  handleManualTradeAllSymbols,
  handleCancelOrder,
  handleDustTransferGet,
  handleDustTransferExecute,
  handlePassword
};
