const { handleLatest } = require('./latest');
const { handleSettingUpdate } = require('./setting-update');
const { handleSymbolUpdate } = require('./symbol-update');
const { handleSymbolDelete } = require('./symbol-delete');

module.exports = {
  handleLatest,
  handleSettingUpdate,
  handleSymbolUpdate,
  handleSymbolDelete
};
