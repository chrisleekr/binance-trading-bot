const _ = require('lodash');
const path = require('path');
const { logger: rootLogger, mongo, cache } = require('../app/helpers');

const migrateConfiguration = (_logger, configuration) => {
  const tradingView = {
    interval: _.get(configuration, 'botOptions.tradingView.interval') || '1h',
    buy: {
      whenStrongBuy: _.get(configuration, 'buy.tradingView.whenStrongBuy'),
      whenBuy: _.get(configuration, 'buy.tradingView.whenBuy')
    },
    sell: {
      forceSellOverZeroBelowTriggerPrice: {
        whenNeutral: _.get(
          configuration,
          'sell.tradingView.forceSellOverZeroBelowTriggerPrice.whenNeutral'
        ),
        whenSell: _.get(
          configuration,
          'sell.tradingView.forceSellOverZeroBelowTriggerPrice.whenSell'
        ),
        whenStrongSell: _.get(
          configuration,
          'sell.tradingView.forceSellOverZeroBelowTriggerPrice.whenStrongSell'
        )
      }
    }
  };

  const tradingViewOptions = {
    useOnlyWithin:
      _.get(configuration, 'botOptions.tradingView.useOnlyWithin') || 5,
    ifExpires:
      _.get(configuration, 'botOptions.tradingView.ifExpires') || 'ignore'
  };

  return _.chain(configuration)
    .omit('botOptions.autoTriggerBuy.conditions.tradingView')
    .omit('sell.tradingView')
    .omit('buy.tradingView')
    .omit('botOptions.tradingView')
    .set('botOptions.tradingViews', [tradingView])
    .set('botOptions.tradingViewOptions', tradingViewOptions)
    .value();
};

module.exports.up = async () => {
  const logger = rootLogger.child({
    gitHash: process.env.GIT_HASH || 'unspecified',
    migration: path.basename(__filename)
  });

  await mongo.connect(logger);

  logger.info('Start migration');

  // Get global configuration
  const globalConfiguration = await mongo.findOne(
    logger,
    'trailing-trade-common',
    {
      key: 'configuration'
    }
  );

  if (globalConfiguration) {
    if (_.get(globalConfiguration, 'botOptions.tradingViews')) {
      logger.warn('Configuration seems already migrated. Skip migration.');
      return;
    }

    const migratedGlobalConfiguration = migrateConfiguration(
      logger,
      globalConfiguration
    );

    await mongo.upsertOne(
      logger,
      'trailing-trade-common',
      { key: 'configuration' },
      { key: 'configuration', ...migratedGlobalConfiguration }
    );
  }

  const migratedSymbolConfigurations = (
    (await mongo.findAll(logger, 'trailing-trade-symbols', {
      key: { $regex: /-configuration/ }
    })) || []
  ).map(configuration => migrateConfiguration(logger, configuration));

  await Promise.all(
    migratedSymbolConfigurations.map(configuration =>
      mongo.upsertOne(
        logger,
        'trailing-trade-symbols',
        { key: configuration.key },
        { key: configuration.key, ...configuration }
      )
    )
  );

  // Delete all cache.
  await mongo.deleteAll(logger, 'trailing-trade-cache', {});

  await cache.hdelall('trailing-trade-configurations:*');
  await cache.hdelall('trailing-trade-tradingview:*');

  logger.info('Finish migration');
};

module.exports.down = next => {
  next();
};
