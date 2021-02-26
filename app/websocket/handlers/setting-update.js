const _ = require('lodash');
const { mongo, cache } = require('../../helpers');

const handleSettingUpdate = async (logger, ws, payload) => {
  logger.info({ payload }, 'Start setting update');

  const { data } = payload;

  const cachedConfiguration = await mongo.findOne(
    logger,
    'simple-stop-chaser-common',
    {
      key: 'configuration'
    }
  );
  logger.info({ cachedConfiguration }, 'Configuration from MongoDB');

  if (!cachedConfiguration) {
    logger.warn({ cachedConfiguration }, 'Failed to parse configuration');
    return;
  }

  const newConfiguration = {
    ...cachedConfiguration,
    ..._.pick(data, [
      'symbols',
      'supportFIATs',
      'candles',
      'maxPurchaseAmount',
      'stopLossLimit'
    ])
  };
  logger.info({ newConfiguration }, 'New configuration');

  await mongo.upsertOne(
    logger,
    'simple-stop-chaser-common',
    { key: 'configuration' },
    {
      key: 'configuration',
      ...newConfiguration
    }
  );
  await cache.hdel('simple-stop-chaser-common', 'exchange-symbols');

  ws.send(
    JSON.stringify({
      result: true,
      type: 'setting-update-result',
      newConfiguration
    })
  );
};

module.exports = { handleSettingUpdate };
