const path = require('path');
const { logger: rootLogger, mongo } = require('../app/helpers');

module.exports.up = async () => {
  const logger = rootLogger.child({
    gitHash: process.env.GIT_HASH || 'unspecified',
    migration: path.basename(__filename)
  });

  const database = await mongo.connect(logger);

  logger.info('Start migration');

  const collectionName = 'trailing-trade-logs';
  const gridTradeLog = database.collection(collectionName);
  try {
    await gridTradeLog.dropIndex(`${collectionName}-logs-idx`);
  } catch (e) {
    logger.warn(`Index '${collectionName}-logs-idx' is not found. It's ok.`);
  }

  // Since the millions logs are generated, it will delete the logs after 30 mins to save the disk space.
  await gridTradeLog.createIndex(
    { loggedAt: 1 },
    {
      name: `${collectionName}-logs-idx`,
      background: true,
      expireAfterSeconds: 1800 // 30 mins
    }
  );

  await gridTradeLog.createIndex(
    { symbol: 1, loggedAt: -1 },
    {
      name: `${collectionName}-logs-idx2`,
      background: true
    }
  );

  logger.info('Finish migration');
};
