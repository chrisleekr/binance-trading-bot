const path = require('path');
const { saveOrderStats } = require('../app/cronjob/trailingTradeHelper/common');
const {
  getConfiguration
} = require('../app/cronjob/trailingTradeHelper/configuration');

const { logger: rootLogger, mongo, cache } = require('../app/helpers');

module.exports.up = async () => {
  const logger = rootLogger.child({
    gitHash: process.env.GIT_HASH || 'unspecified',
    migration: path.basename(__filename)
  });

  await mongo.connect(logger);

  logger.info('Start migration');

  const globalConfiguration = await getConfiguration(logger);

  await saveOrderStats(logger, globalConfiguration.symbols);

  cache.hdelall('trailing-trade-configurations:*');

  logger.info('Finish migration');
};

module.exports.down = next => {
  next();
};
