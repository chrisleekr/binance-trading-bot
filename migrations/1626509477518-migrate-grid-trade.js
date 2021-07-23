const path = require('path');
const { logger: rootLogger, mongo } = require('../app/helpers');

const migrateGlobalConfiguration = (logger, oldConfiguration) => {
  const newConfiguration = oldConfiguration;
  if (!newConfiguration) {
    return newConfiguration;
  }

  if (newConfiguration.buy.gridTrade === undefined) {
    const {
      buy: {
        triggerPercentage,
        stopPercentage,
        limitPercentage,
        maxPurchaseAmounts
      }
    } = oldConfiguration;

    newConfiguration.buy.gridTrade = [
      {
        triggerPercentage,
        stopPercentage,
        limitPercentage,
        maxPurchaseAmount: -1,
        maxPurchaseAmounts
      }
    ];

    delete newConfiguration.buy.triggerPercentage;
    delete newConfiguration.buy.stopPercentage;
    delete newConfiguration.buy.limitPercentage;
    delete newConfiguration.buy.maxPurchaseAmount;
    delete newConfiguration.buy.maxPurchaseAmounts;
  }

  if (newConfiguration.sell.gridTrade === undefined) {
    const {
      sell: { triggerPercentage, stopPercentage, limitPercentage }
    } = oldConfiguration;

    newConfiguration.sell.gridTrade = [
      {
        triggerPercentage,
        stopPercentage,
        limitPercentage,
        quantityPercentage: -1,
        quantityPercentages: {}
      }
    ];

    delete newConfiguration.sell.triggerPercentage;
    delete newConfiguration.sell.stopPercentage;
    delete newConfiguration.sell.limitPercentage;
  }

  logger.info({ newConfiguration }, 'New migrated configuration');

  return newConfiguration;
};

const migrateSymbolConfiguration = (logger, oldConfiguration) => {
  const newConfiguration = oldConfiguration;

  if (newConfiguration.buy.gridTrade === undefined) {
    const {
      buy: {
        triggerPercentage,
        stopPercentage,
        limitPercentage,
        maxPurchaseAmount
      }
    } = oldConfiguration;

    newConfiguration.buy.gridTrade = [
      {
        triggerPercentage,
        stopPercentage,
        limitPercentage,
        maxPurchaseAmount
      }
    ];

    delete newConfiguration.buy.triggerPercentage;
    delete newConfiguration.buy.stopPercentage;
    delete newConfiguration.buy.limitPercentage;
    delete newConfiguration.buy.maxPurchaseAmount;
  }

  if (newConfiguration.sell.gridTrade === undefined) {
    const {
      sell: { triggerPercentage, stopPercentage, limitPercentage }
    } = oldConfiguration;

    newConfiguration.sell.gridTrade = [
      {
        triggerPercentage,
        stopPercentage,
        limitPercentage,
        quantityPercentage: 1
      }
    ];

    delete newConfiguration.sell.triggerPercentage;
    delete newConfiguration.sell.stopPercentage;
    delete newConfiguration.sell.limitPercentage;
  }

  logger.info({ newConfiguration }, 'New migrated configuration');

  return newConfiguration;
};

module.exports.up = async next => {
  const logger = rootLogger.child({
    gitHash: process.env.GIT_HASH || 'unspecified',
    migration: path.basename(__filename)
  });

  await mongo.connect(logger);

  logger.info('Start migration');

  // Get symbol configuration
  const symbolConfigurations = await mongo.findAll(
    logger,
    'trailing-trade-symbols',
    {
      key: { $regex: /^(.+)-configuration/ }
    }
  );

  // Migrate symbol configuration
  const newSymbolConfigurations = symbolConfigurations.map(configuration =>
    migrateSymbolConfiguration(logger, configuration)
  );

  // Update symbol configuration
  await Promise.all(
    newSymbolConfigurations.map(configuration => {
      const { key } = configuration;
      return mongo.upsertOne(
        logger,
        'trailing-trade-symbols',
        { key },
        { key, ...configuration }
      );
    })
  );

  // Get global configuration
  const globalConfiguration = await mongo.findOne(
    logger,
    'trailing-trade-common',
    {
      key: 'configuration'
    }
  );

  // Migrate global configuration
  const newGlobalConfiguration = migrateGlobalConfiguration(
    logger,
    globalConfiguration
  );

  // Update global configuration
  await mongo.upsertOne(
    logger,
    'trailing-trade-common',
    { key: 'configuration' },
    { key: 'configuration', ...newGlobalConfiguration }
  );

  logger.info('Finish migration');

  next();
};

module.exports.down = next => {
  next();
};
