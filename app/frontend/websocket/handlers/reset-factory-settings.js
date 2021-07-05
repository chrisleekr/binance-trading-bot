
const {
  resetToFactorySettings,
  resetToFactorySettingsWithSymbols,
  getGlobalConfiguration
} = require('../../../cronjob/trailingTradeHelper/configuration');

const handleResetFactorySettings = async (logger, ws, payload) => {
  logger.info({ payload }, 'Start resetting to factory settings');

  const { data: newConfiguration } = payload;

  const { action } = newConfiguration;

  const config = await getGlobalConfiguration(logger);

  if (action == 'reset-factory-settings-minus-symbols') {
    await resetToFactorySettingsWithSymbols(logger, config.symbols);
  } else {
    await resetToFactorySettings(logger, config.symbols);
  }

  ws.send(JSON.stringify({ result: true, type: 'reset-successful' }));

};

module.exports = { handleResetFactorySettings };
