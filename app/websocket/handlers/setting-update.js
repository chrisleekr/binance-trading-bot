const _ = require('lodash');
const { cache } = require('../../helpers');

const handleSettingUpdate = async (logger, ws, payload) => {
  logger.info({ payload }, 'Start setting update');

  const { data } = payload;

  const cachedConfigValue = await cache.hget(
    'simple-stop-chaser-common',
    'configuration'
  );

  let cachedConfiguration = {};
  try {
    cachedConfiguration = JSON.parse(cachedConfigValue);
  } catch (e) {
    logger.warn({ cachedConfigValue }, 'Failed to parse configuration');
    return;
  }

  const newConfiguration = {
    ...cachedConfiguration,
    ..._.pick(data, [
      'symbols',
      'candles',
      'maxPurchaseAmount',
      'stopLossLimit'
    ])
  };
  logger.info({ newConfiguration }, 'New configuration');

  await cache.hset(
    'simple-stop-chaser-common',
    'configuration',
    JSON.stringify(newConfiguration)
  );

  ws.send(
    JSON.stringify({
      result: true,
      type: 'setting-update-result',
      newConfiguration
    })
  );
};

module.exports = { handleSettingUpdate };
