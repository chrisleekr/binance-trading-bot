/* istanbul ignore file */
const { mongo, logger } = require('../helpers');

(async () => {
  logger.info('Test inserting');

  await mongo.connect(logger);

  await mongo.findOne(logger, 'test', { key: 'non-exist' });

  await mongo.insertOne(logger, 'test', { key: 'my-key', value: 1 });

  await mongo.findOne(logger, 'test', { key: 'my-key' });

  await mongo.upsertOne(logger, 'test', { key: 'my-key' }, { value: 2 });

  await mongo.findOne(logger, 'test', { key: 'my-key' });

  await mongo.deleteOne(logger, 'test', { key: 'my-key' });

  process.exit(0);
})();
