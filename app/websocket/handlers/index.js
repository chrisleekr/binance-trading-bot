const { handleLatest } = require('./latest');
const { handleSettingUpdate } = require('./setting-update');
const { handleSymbolUpdate } = require('./symbol-update');
const { handleSymbolDelete } = require('./symbol-delete');
const { handleSymbolSettingUpdate } = require('./symbol-setting-update');

module.exports = {
  handleLatest,
  handleSettingUpdate,
  handleSymbolUpdate,
  handleSymbolDelete,
  handleSymbolSettingUpdate
};
