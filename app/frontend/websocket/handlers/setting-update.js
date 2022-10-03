const _ = require('lodash');
const config = require('config');
const { cache, PubSub } = require('../../../helpers');
const {
  getGlobalConfiguration,
  saveGlobalConfiguration,
  deleteAllSymbolConfiguration
} = require('../../../cronjob/trailingTradeHelper/configuration');

/**
 * Quick fix to delete all cached symbol info
 *
 * @param {*} logger
 */
const deleteAllCachedSymbolInfo = async logger => {
  await cache.hdel('trailing-trade-common', 'exchange-symbols');
  await cache.hdel('trailing-trade-common', 'exchange-info');

  const symbolKeys = await cache.hgetall(
    'trailing-trade-symbols:',
    'trailing-trade-symbols:*-symbol-info'
  );

  await Promise.all(
    Object.keys(symbolKeys).map(async key => {
      await cache.hdel('trailing-trade-symbols', key);
      logger.info(`Removed trailing-trade-symbols:${key} cache`);
    })
  );
};

const handleSettingUpdate = async (logger, ws, payload) => {
  logger.info({ payload }, 'Start setting update');

  if (config.get('demoMode')) {
    PubSub.publish('frontend-notification', {
      type: 'warning',
      title: `You cannot update settings in the demo mode.`
    });
    return;
  }

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
      'candles',
      'buy',
      'sell',
      'botOptions'
    ])
  };

  // Set purchase amount to be -1, which mean purchase amount
  // will be automatically calculate based on the notional amount.
  mergedConfiguration.buy.minPurchaseAmount = -1;
  mergedConfiguration.buy.maxPurchaseAmount = -1;
  mergedConfiguration.buy.lastBuyPriceRemoveThreshold = -1;

  logger.info({ mergedConfiguration }, 'New merged configuration');

  await saveGlobalConfiguration(logger, mergedConfiguration);

  // Delete cached exchange symbols to retrieve again.
  await deleteAllCachedSymbolInfo(logger);

  if (action === 'apply-to-all') {
    // In this case delete all symbol configuration
    await deleteAllSymbolConfiguration(logger);
  }

  ws.send(
    JSON.stringify({
      result: true,
      type: 'setting-update-result',
      newConfiguration: mergedConfiguration
    })
  );
};

module.exports = { handleSettingUpdate };
