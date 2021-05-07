const _ = require('lodash');
const config = require('config');
const { mongo, cache, PubSub } = require('../../helpers');

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
 * Backward compatibility function to check stop loss configuration
 *
 * @param {*} globalConfiguration
 */
const hasSellStopLoss = globalConfiguration =>
  _.get(globalConfiguration, 'sell.stopLoss.enabled', null) !== null;

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

  // Backward compatibility to check stopLoss config
  if (hasSellStopLoss(configValue) === false) {
    // If stop loss configuration does not exist, then get from config.
    const initialConfigValue = config.get('jobs.trailingTrade');

    configValue.sell.stopLoss = _.get(initialConfigValue, 'sell.stopLoss');

    // Save one more time. This code block should not happen once saved.
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

  const configValue =
    (await mongo.findOne(logger, 'trailing-trade-symbols', {
      key: `${symbol}-configuration`
    })) || {};

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

const getMaxPurchaseAmount = async (
  logger,
  symbol,
  globalConfiguration,
  symbolConfiguration
) => {
  const symbolBuyMaxPurchaseAmount = _.get(
    symbolConfiguration,
    'buy.maxPurchaseAmount',
    -1
  );

  if (symbolBuyMaxPurchaseAmount !== -1) {
    logger.info(
      { symbolBuyMaxPurchaseAmount },
      'Max purchase amount is found from symbol configuration.'
    );
    return symbolBuyMaxPurchaseAmount;
  }

  logger.info(
    { symbolBuyMaxPurchaseAmount },
    'Max purchase amount is set as -1. Need to calculate and override it'
  );

  let newBuyMaxPurchaseAmount = -1;

  // If old max purchase maount is -1, then should calculate maximum purchase amount based on the notional amount.
  const cachedSymbolInfo =
    JSON.parse(
      await cache.hget('trailing-trade-symbols', `${symbol}-symbol-info`)
    ) || {};

  if (_.isEmpty(cachedSymbolInfo) === false) {
    const {
      quoteAsset,
      filterMinNotional: { minNotional }
    } = cachedSymbolInfo;

    newBuyMaxPurchaseAmount = _.get(
      globalConfiguration,
      `buy.maxPurchaseAmounts.${quoteAsset}`,
      -1
    );

    logger.info(
      { quoteAsset, newBuyMaxPurchaseAmount },
      'Retreived max purchase amount from global configuration'
    );

    if (newBuyMaxPurchaseAmount === -1) {
      newBuyMaxPurchaseAmount = parseFloat(minNotional) * 10;

      logger.info(
        { newBuyMaxPurchaseAmount, minNotional },
        'Could not get max purchase amount from global configuration. Use minimum notional from symbol info'
      );
    }
  } else {
    logger.info(
      { cachedSymbolInfo },
      'Could not find symbol info, wait to be cached.'
    );
  }

  return newBuyMaxPurchaseAmount;
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
  const mergedConfigValue = _.defaultsDeep(
    symbolConfigValue,
    globalConfigValue
  );
  if (symbol !== null) {
    _.set(
      mergedConfigValue,
      'buy.maxPurchaseAmount',
      await getMaxPurchaseAmount(
        logger,
        symbol,
        globalConfigValue,
        symbolConfigValue
      )
    );

    // For symbol configuration, remove maxPurchaseAmounts
    _.unset(mergedConfigValue, 'buy.maxPurchaseAmounts');
  }

  // Merge global and symbol configuration
  return mergedConfigValue;
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
