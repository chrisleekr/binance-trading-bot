const path = require('path');
const { logger: rootLogger, mongo } = require('../app/helpers');

module.exports.up = async () => {
  const logger = rootLogger.child({
    gitHash: process.env.GIT_HASH || 'unspecified',
    migration: path.basename(__filename)
  });

  const database = await mongo.connect(logger);

  logger.info('Start migration');

  const collectionName = 'trailing-trade-cache';

  const collection = database.collection(collectionName);

  const result = await collection.createIndex(
    { symbol: 1 },
    { name: `${collectionName}-idx`, unique: true }
  );
  logger.info(
    { collectionName, result },
    'Created collection index for key fields'
  );

  logger.info('Finish migration');
};

module.exports.down = next => {
  next();
};
