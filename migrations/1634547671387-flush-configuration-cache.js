const path = require('path');
const { logger: rootLogger, cache } = require('../app/helpers');

module.exports.up = async () => {
  const logger = rootLogger.child({
    gitHash: process.env.GIT_HASH || 'unspecified',
    migration: path.basename(__filename)
  });

  logger.info('Start migration');

  cache.hdelall('trailing-trade-configurations:*');

  logger.info('Finish migration');
};

module.exports.down = next => {
  next();
};
