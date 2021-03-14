const _ = require('lodash');
const config = require('config');
const { mongo } = require('../../helpers');

/**
 * Get global configuration from mongodb
 *
 * @param {*} logger
 */
const getGlobalConfiguration = async logger => {
  const configValue = await mongo.findOne(logger, 'trailing-trade-common', {
    key: 'configuration'
  });

  if (_.isEmpty(configValue)) {
    logger.info('Could not find global configuration.');
    return {};
  }

  return configValue;
};

/**
 * Get symbol configuration from mongodb
 *
 * @param {*} logger
 * @param {*} symbol
 */
const getSymbolConfiguration = async (logger, symbol = null) => {
  if (symbol === null) {
    // If symbol is not provided, then return empty.
    return {};
  }

  const configValue = await mongo.findOne(logger, 'trailing-trade-symbols', {
    key: `${symbol}-configuration`
  });

  if (_.isEmpty(configValue)) {
    logger.info('Could not find symbol configuration.');
    return {};
  }

  return configValue;
};

/**
 * Save global configuration to mongodb
 *
 * @param {*} logger
 * @param {*} configuration
 */
const saveGlobalConfiguration = async (logger, configuration) =>
  mongo.upsertOne(
    logger,
    'trailing-trade-common',
    {
      key: 'configuration'
    },
    {
      key: 'configuration',
      ...configuration
    }
  );

/**
 * Save symbol configuration to mongodb
 *
 * @param {*} logger
 * @param {*} symbol
 * @param {*} configuration
 */
const saveSymbolConfiguration = async (
  logger,
  symbol = null,
  configuration = {}
) => {
  if (symbol === null) {
    // If symbol is not provided, then return empty.
    return {};
  }

  return mongo.upsertOne(
    logger,
    'trailing-trade-symbols',
    {
      key: `${symbol}-configuration`
    },
    {
      key: `${symbol}-configuration`,
      ...configuration
    }
  );
};

/**
 * Get global/symbol configuration
 *
 * @param {*} logger
 * @param {*} symbol
 */
const getConfiguration = async (logger, symbol = null) => {
  // If symbol is not provided, then it only looks up global configuration
  const globalConfigValue = await getGlobalConfiguration(logger);
  const symbolConfigValue = await getSymbolConfiguration(logger, symbol);

  // Merge global and symbol configuration
  const configValue = _.defaultsDeep(symbolConfigValue, globalConfigValue);

  let trailingTradeConfig = {};
  if (_.isEmpty(configValue) === false) {
    logger.info('Found configuration from MongoDB');

    trailingTradeConfig = configValue;
  } else {
    logger.info(
      'Could not find configuration from MongoDB, retrieve from initial configuration.'
    );

    // If it is empty, then global configuration is not stored in the
    trailingTradeConfig = config.get('jobs.trailingTrade');

    await saveGlobalConfiguration(logger, trailingTradeConfig);
  }

  return trailingTradeConfig;
};

module.exports = {
  getGlobalConfiguration,
  getSymbolConfiguration,
  saveGlobalConfiguration,
  saveSymbolConfiguration,
  getConfiguration
};
