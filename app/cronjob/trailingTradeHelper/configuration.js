const _ = require('lodash');
const config = require('config');
const { mongo, PubSub } = require('../../helpers');

/**
 * Save global configuration to mongodb
 *
 * @param {*} logger
 * @param {*} configuration
 */
const saveGlobalConfiguration = async (logger, configuration) => {
  // Save to cache for watching changes.
  const result = await mongo.upsertOne(
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

  PubSub.publish('trailing-trade-configuration-changed', true);

  return result;
};

/**
 * Get global configuration from mongodb
 *
 * @param {*} logger
 */
const getGlobalConfiguration = async logger => {
  let configValue = await mongo.findOne(logger, 'trailing-trade-common', {
    key: 'configuration'
  });

  if (_.isEmpty(configValue)) {
    logger.info(
      'Could not find configuration from MongoDB, retrieve from initial configuration.'
    );

    // If it is empty, then global configuration is not stored in the
    configValue = config.get('jobs.trailingTrade');

    await saveGlobalConfiguration(logger, configValue);
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

const deleteAllSymbolConfiguration = async logger =>
  mongo.deleteAll(logger, 'trailing-trade-symbols', {
    key: { $regex: /^(.+)-configuration/ }
  });

const deleteSymbolConfiguration = async (logger, symbol) =>
  mongo.deleteOne(logger, 'trailing-trade-symbols', {
    key: `${symbol}-configuration`
  });

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
  return _.defaultsDeep(symbolConfigValue, globalConfigValue);
};

module.exports = {
  getGlobalConfiguration,
  getSymbolConfiguration,
  saveGlobalConfiguration,
  saveSymbolConfiguration,
  deleteAllSymbolConfiguration,
  deleteSymbolConfiguration,
  getConfiguration
};
