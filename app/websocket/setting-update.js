const _ = require('lodash');
const config = require('config');
const { cache } = require('../helpers');

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

  const simpleStopChaserConfig = config.get('jobs.simpleStopChaser');

  const newConfiguration = {
    ...cachedConfiguration,
    ..._.pick(simpleStopChaserConfig, ['symbols']),
    ..._.pick(data, ['candles', 'maxPurchaseAmount', 'stopLossLimit'])
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
