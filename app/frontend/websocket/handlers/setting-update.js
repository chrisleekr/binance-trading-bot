const _ = require('lodash');
const { cache } = require('../../../helpers');
const {
  getGlobalConfiguration,
  saveGlobalConfiguration,
  deleteAllSymbolConfiguration
} = require('../../../cronjob/trailingTradeHelper/configuration');

const handleSettingUpdate = async (logger, ws, payload) => {
  logger.info({ payload }, 'Start setting update');

  const { data: newConfiguration } = payload;

  const { action } = newConfiguration;

  const cachedConfiguration = await getGlobalConfiguration(logger);
  logger.info({ cachedConfiguration }, 'Configuration from MongoDB');

  if (!cachedConfiguration) {
    logger.warn({ cachedConfiguration }, 'Failed to parse configuration');
    return;
  }

  const mergedConfiguration = {
    ...cachedConfiguration,
    ..._.pick(newConfiguration, [
      'symbols',
      'supportFIATs',
      'candles',
      'buy',
      'sell'
    ])
  };
  logger.info({ mergedConfiguration }, 'New merged configuration');

  await saveGlobalConfiguration(logger, mergedConfiguration);

  // Delete cached exchange symbols to retrieve again.
  await cache.hdel('trailing-trade-common', 'exchange-symbols');

  if (action === 'apply-to-all') {
    // In this case delete all symbol configuration
    await deleteAllSymbolConfiguration(logger);
  }

  ws.send(
    JSON.stringify({
      result: true,
      type: 'setting-update-result',
      newConfiguration
    })
  );
};

module.exports = { handleSettingUpdate };
