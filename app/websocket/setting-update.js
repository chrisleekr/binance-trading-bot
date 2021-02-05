const { cache } = require('../helpers');

const handleSettingUpdate = async (logger, ws, payload) => {
  logger.info({ payload }, 'Start setting update');

  const { data } = payload;

  const configValue = await cache.hget(
    'simple-stop-chaser-common',
    'configuration'
  );

  let configuration = {};
  try {
    configuration = JSON.parse(configValue);
  } catch (e) {
    logger.warn({ configValue }, 'Failed to parse configuration');
    return;
  }

  configuration = { ...configuration, ...data };
  logger.info({ configuration }, 'New configuration');

  await cache.hset(
    'simple-stop-chaser-common',
    'configuration',
    JSON.stringify(configuration)
  );

  ws.send(
    JSON.stringify({
      result: true,
      type: 'setting-update-result',
      configuration
    })
  );
};

module.exports = { handleSettingUpdate };
