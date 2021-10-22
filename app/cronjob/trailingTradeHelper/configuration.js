const _ = require('lodash');
const moment = require('moment');
const config = require('config');
const { mongo, cache, PubSub } = require('../../helpers');

const { getLastBuyPrice, getSymbolInfo } = require('./common');

/**
 * Reconfigure MongoDB index
 * @param {*} logger
 * @param {*} configuration
 */
const reconfigureIndex = async (logger, configuration) => {
  logger.info('Reconfigure index');
  const {
    botOptions: {
      logs: { deleteAfter: logsDeleteAfter }
    }
  } = configuration;

  // Drop trailing-trade-logs-logs-idx
  try {
    await mongo.dropIndex(
      logger,
      'trailing-trade-logs',
      'trailing-trade-logs-logs-idx'
    );
  } catch (e) {
    /* istanbul ignore next */
    logger.info({ e }, "Cannot find index. But it's ok to ignore.");
  }

  // Create trailing-trade-logs-logs-idx

  await mongo.createIndex(
    logger,
    'trailing-trade-logs',
    { loggedAt: 1 },
    {
      name: 'trailing-trade-logs-logs-idx',
      background: true,
      expireAfterSeconds: logsDeleteAfter * 60
    }
  );
};

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

  await cache.hdelall('trailing-trade-configurations:*');

  await reconfigureIndex(logger, configuration);
  PubSub.publish('reset-binance-websocket', true);

  return result;
};

/**
 * Get global configuration from mongodb
 *
 * @param {*} logger
 */
const getGlobalConfiguration = async logger => {
  const orgConfigValue = config.get('jobs.trailingTrade');

  orgConfigValue.symbols = Object.values(orgConfigValue.symbols);

  const savedConfigValue = await mongo.findOne(
    logger,
    'trailing-trade-common',
    {
      key: 'configuration'
    }
  );

  if (_.isEmpty(savedConfigValue)) {
    logger.info(
      'Could not find configuration from MongoDB, retrieve from initial configuration.'
    );

    // If it is empty, then global configuration is not stored in the
    await saveGlobalConfiguration(logger, orgConfigValue);
  }

  return _.mergeWith(savedConfigValue, orgConfigValue, (objValue, srcValue) => {
    if (_.isArray(objValue) || !_.isObject(objValue)) {
      return objValue;
    }
    return _.defaultsDeep(objValue, srcValue);
  });
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
 * Get symbol's grid trade configuration from mongodb
 *
 * @param {*} logger
 * @param {*} symbol
 */
const getSymbolGridTrade = async (logger, symbol = null) => {
  if (symbol === null) {
    // If symbol is not provided, then return empty.
    return {};
  }

  const configValue =
    (await mongo.findOne(logger, 'trailing-trade-grid-trade', {
      key: `${symbol}`
    })) || {};

  if (_.isEmpty(configValue)) {
    logger.info('Could not find saved symbol grid trade.');
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

  const result = await mongo.upsertOne(
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

  await cache.hdel('trailing-trade-configurations', symbol);

  return result;
};

/**
 * Save symbol grid trade to mongodb
 *
 * @param {*} logger
 * @param {*} symbol
 * @param {*} gridTrade
 */
const saveSymbolGridTrade = async (logger, symbol = null, gridTrade = {}) => {
  if (symbol === null) {
    // If symbol is not provided, then return empty.
    return {};
  }
  logger.info({ gridTrade, saveLog: true }, 'The grid trade has been updated.');

  const result = await mongo.upsertOne(
    logger,
    'trailing-trade-grid-trade',
    {
      key: `${symbol}`
    },
    {
      key: `${symbol}`,
      ...gridTrade
    }
  );

  await cache.hdel('trailing-trade-configurations', symbol);

  return result;
};

/**
 * Calculate grid trade profit
 *
 * @param {*} buyGridTrade
 * @param {*} sellGridTrade
 * @param {*} stopLossOrder
 * @param {*} manualTrade
 *
 * @returns
 */
const calculateGridTradeProfit = (
  buyGridTrade = [],
  sellGridTrade = [],
  stopLossOrder = {},
  manualTrade = []
) => {
  const buyGridTradeQuoteQty =
    _.isEmpty(buyGridTrade) === false
      ? buyGridTrade.reduce(
          (acc, t) =>
            acc +
            (t.executed
              ? parseFloat(t.executedOrder?.cummulativeQuoteQty || 0)
              : 0),
          0
        )
      : 0;

  const buyManualQuoteQty =
    _.isEmpty(manualTrade) === false
      ? manualTrade.reduce(
          (acc, t) =>
            acc +
            (t.side.toLowerCase() === 'buy'
              ? parseFloat(t.cummulativeQuoteQty || 0)
              : 0),
          0
        )
      : 0;

  const sellGridTradeQuoteQty =
    _.isEmpty(sellGridTrade) === false
      ? sellGridTrade.reduce(
          (acc, t) =>
            acc +
            (t.executed
              ? parseFloat(t.executedOrder?.cummulativeQuoteQty || 0)
              : 0),
          0
        )
      : 0;

  const sellManualQuoteQty =
    _.isEmpty(manualTrade) === false
      ? manualTrade.reduce(
          (acc, t) =>
            acc +
            (t.side.toLowerCase() === 'sell'
              ? parseFloat(t.cummulativeQuoteQty || 0)
              : 0),
          0
        )
      : 0;

  const stopLossQuoteQty = parseFloat(stopLossOrder?.cummulativeQuoteQty || 0);

  const totalBuyQuoteQty = buyGridTradeQuoteQty + buyManualQuoteQty;
  const totalSellQuoteQty =
    sellGridTradeQuoteQty + sellManualQuoteQty + stopLossQuoteQty;

  const profit = totalSellQuoteQty - totalBuyQuoteQty;

  const profitPercentage =
    profit !== 0 && totalBuyQuoteQty !== 0
      ? (profit / totalBuyQuoteQty) * 100
      : 0;

  const buyGridTradeExecuted =
    _.isEmpty(buyGridTrade) === false
      ? buyGridTrade.some(t => t.executed === true)
      : false;

  const allBuyGridTradeExecuted =
    _.isEmpty(buyGridTrade) === false
      ? buyGridTrade.every(t => t.executed === true)
      : false;

  const sellGridTradeExecuted =
    _.isEmpty(sellGridTrade) === false
      ? sellGridTrade.some(t => t.executed === true)
      : false;

  const allSellGridTradeExecuted =
    _.isEmpty(sellGridTrade) === false
      ? sellGridTrade.every(t => t.executed === true)
      : false;

  return {
    buyGridTradeExecuted,
    sellGridTradeExecuted,
    allExecuted: allBuyGridTradeExecuted && allSellGridTradeExecuted,
    totalBuyQuoteQty,
    totalSellQuoteQty,
    buyGridTradeQuoteQty,
    buyManualQuoteQty,
    sellGridTradeQuoteQty,
    sellManualQuoteQty,
    stopLossQuoteQty,
    profit,
    profitPercentage
  };
};

/**
 * Archive symbol grid trade to mongodb
 *
 * @param {*} logger
 * @param {*} key
 * @param {*} gridTrade
 */
const saveSymbolGridTradeArchive = async (logger, key = null, data = {}) => {
  if (key === null) {
    // If key is not provided, then return empty.
    return {};
  }

  logger.info({ data, saveLog: true }, 'The grid trade has been archived.');

  const result = await mongo.upsertOne(
    logger,
    'trailing-trade-grid-trade-archive',
    {
      key
    },
    {
      key,
      ...data
    }
  );

  // Refresh configuration
  const { symbol } = data;
  await cache.hdel('trailing-trade-configurations', symbol);

  return result;
};

/**
 * Archive symbol grid trade
 *
 * @param {*} logger
 * @param {*} symbol
 * @returns
 */
const archiveSymbolGridTrade = async (logger, symbol = null) => {
  // Retrieve symbol info
  const symbolInfo = await getSymbolInfo(logger, symbol);

  // Get current symbol grid trade
  const symbolGridTrade = await getSymbolGridTrade(logger, symbol);

  // If not exist, then return false
  if (_.isEmpty(symbolGridTrade)) {
    return {};
  }

  // If exist, calculate profit
  const {
    buy: buyGridTrade,
    sell: sellGridTrade,
    stopLoss,
    manualTrade
  } = symbolGridTrade;

  const gridProfit = calculateGridTradeProfit(
    buyGridTrade,
    sellGridTrade,
    stopLoss,
    manualTrade
  );

  // Save to archive
  const archivedGridTrade = {
    symbol,
    ..._.pick(symbolInfo, ['baseAsset', 'quoteAsset']),
    ...gridProfit,
    ..._.omit(symbolGridTrade, 'key', '_id'),
    archivedAt: moment().format()
  };

  await saveSymbolGridTradeArchive(
    logger,
    `${symbol}-${moment().format()}`,
    archivedGridTrade
  );

  // Refresh configuration
  await cache.hdel('trailing-trade-configurations', symbol);

  return archivedGridTrade;
};

/**
 * Delete all symbol configurations
 *
 * @param {*} logger
 * @returns
 */
const deleteAllSymbolConfiguration = async logger => {
  const result = await mongo.deleteAll(logger, 'trailing-trade-symbols', {
    key: { $regex: /^(.+)-configuration/ }
  });

  await cache.hdelall('trailing-trade-configurations:*');
  return result;
};

/**
 * Delete specific symbol configuration
 * @param {*} logger
 * @param {*} symbol
 * @returns
 */
const deleteSymbolConfiguration = async (logger, symbol) => {
  const result = await mongo.deleteOne(logger, 'trailing-trade-symbols', {
    key: `${symbol}-configuration`
  });

  await cache.hdel('trailing-trade-configurations', symbol);
  return result;
};

/**
 * Delete all symbol grid trade information
 *
 * @param {*} logger
 * @returns
 */
const deleteAllSymbolGridTrade = async logger => {
  const result = await mongo.deleteAll(logger, 'trailing-trade-grid-trade', {});

  await cache.hdelall(`trailing-trade-configurations:*`);

  return result;
};

/**
 * Delete specific symbol grid trade information
 * @param {*} logger
 * @param {*} symbol
 * @returns
 */
const deleteSymbolGridTrade = async (logger, symbol) => {
  const result = await mongo.deleteOne(logger, 'trailing-trade-grid-trade', {
    key: `${symbol}`
  });

  await cache.hdel('trailing-trade-configurations', symbol);

  return result;
};

/**
 * Get buy max purchase amount of grid trade for buying
 *
 * @param {*} logger
 * @param {*} cachedSymbolInfo
 * @param {*} globalConfiguration
 * @param {*} symbolConfiguration
 * @returns
 */
const getGridTradeBuy = (
  logger,
  cachedSymbolInfo,
  globalConfiguration,
  symbolConfiguration
) => {
  const {
    buy: { gridTrade: srcGridTrade }
  } = symbolConfiguration;

  let orgGridTrade = srcGridTrade;
  if (_.isEmpty(srcGridTrade)) {
    orgGridTrade = globalConfiguration.buy.gridTrade;
  }

  // Loop symbol's buy.gridTrade
  const gridTrade = orgGridTrade.map((orgGrid, index) => {
    const grid = orgGrid;

    // Retrieve configured min/max purchase amount.
    [
      {
        symbolKey: 'minPurchaseAmount',
        globalKey: 'minPurchaseAmounts'
      },
      {
        symbolKey: 'maxPurchaseAmount',
        globalKey: 'maxPurchaseAmounts'
      }
    ].forEach(conf => {
      const symbolMaxPurchaseAmount = _.get(grid, conf.symbolKey, -1);

      // If max purchase amount is not -1, then it is already configrued. Return grid.
      if (symbolMaxPurchaseAmount !== -1) {
        _.unset(grid, conf.globalKey);
      } else {
        let newAmount = -1;

        if (_.isEmpty(cachedSymbolInfo) === false) {
          const {
            quoteAsset,
            filterMinNotional: { minNotional }
          } = cachedSymbolInfo;

          // Retrieve configured max purchase amount for the quote asset from the global configuration.
          newAmount = _.get(
            globalConfiguration,
            `buy.gridTrade[${index}].${conf.globalKey}[${quoteAsset}]`,
            -1
          );

          // If max purchase amount for the quote asset in the global configuration is not defined,
          // then use the minimum notional value * 10.
          if (newAmount === -1) {
            newAmount =
              parseFloat(minNotional) *
              (conf.symbolKey === 'maxPurchaseAmount' ? 10 : 1);
          }
        } else {
          logger.info(
            { cachedSymbolInfo },
            `Could not find symbol info for buy ${conf.globalKey}, wait to be cached.`
          );
        }

        _.set(grid, conf.symbolKey, newAmount);
        _.unset(grid, conf.globalKey);
      }
    });

    return grid;
  });

  return gridTrade;
};

/**
 * Get quantity percentage of grid trade for selling
 *
 * @param {*} logger
 * @param {*} cachedSymbolInfo
 * @param {*} globalConfiguration
 * @param {*} symbolConfiguration
 * @returns
 */
const getGridTradeSell = (
  logger,
  cachedSymbolInfo,
  globalConfiguration,
  symbolConfiguration
) => {
  const {
    sell: { gridTrade: srcGridTrade }
  } = symbolConfiguration;

  let orgGridTrade = srcGridTrade;
  if (_.isEmpty(srcGridTrade)) {
    orgGridTrade = globalConfiguration.sell.gridTrade;
  }
  const gridTradeLength = orgGridTrade.length;

  // Loop symbol's sell.gridTrade
  const gridTrade = orgGridTrade.map((orgGrid, index) => {
    const grid = orgGrid;

    // Retrieve configrued quantity percentage
    const symbolQuantityPercentage = _.get(grid, 'quantityPercentage', -1);

    if (symbolQuantityPercentage !== -1) {
      _.unset(grid, 'quantityPercentages');
      return grid;
    }

    let newQuantityPercentage = -1;

    // Retrieve symbol information cache
    if (_.isEmpty(cachedSymbolInfo) === false) {
      const { quoteAsset } = cachedSymbolInfo;

      // Retrieve configured quantity percentage for the quote asset from the global configuration.
      newQuantityPercentage = _.get(
        globalConfiguration,
        `sell.gridTrade[${index}].quantityPercentages[${quoteAsset}]`,
        -1
      );

      // If quantity percentage for the quote asset in the global configuration is not defined,
      // then set custom quantity.
      if (newQuantityPercentage === -1) {
        newQuantityPercentage =
          gridTradeLength !== index + 1
            ? parseFloat((1 / gridTradeLength).toFixed(2))
            : 1;
      }
    } else {
      logger.info(
        { cachedSymbolInfo },
        'Could not find symbol info for sell quantity percentage, wait to be cached.'
      );
    }

    _.set(grid, 'quantityPercentage', newQuantityPercentage);
    _.unset(grid, 'quantityPercentages');

    return grid;
  });

  return gridTrade;
};

/**
 * Get last buy price remove threshold
 * @param {*} logger
 * @param {*} cachedSymbolInfo
 * @param {*} globalConfiguration
 * @param {*} symbolConfiguration
 * @returns
 */
const getLastBuyPriceRemoveThreshold = (
  logger,
  cachedSymbolInfo,
  globalConfiguration,
  symbolConfiguration
) => {
  const symbolBuyLastBuyPriceRemoveThreshold = _.get(
    symbolConfiguration,
    'buy.lastBuyPriceRemoveThreshold',
    -1
  );

  if (symbolBuyLastBuyPriceRemoveThreshold !== -1) {
    logger.info(
      { symbolBuyLastBuyPriceRemoveThreshold },
      'Last buy threshold is found from symbol configuration.'
    );
    return symbolBuyLastBuyPriceRemoveThreshold;
  }

  logger.info(
    { symbolBuyLastBuyPriceRemoveThreshold },
    'Last Buy Price Remove Threshold is set as -1. Need to calculate and override it'
  );

  let newBuyLastBuyPriceRemoveThreshold = -1;

  // If old last buy price remove threshold is -1,
  // then should calculate last buy price remove threshold based on the notional amount.
  if (_.isEmpty(cachedSymbolInfo) === false) {
    const {
      quoteAsset,
      filterMinNotional: { minNotional }
    } = cachedSymbolInfo;

    newBuyLastBuyPriceRemoveThreshold = _.get(
      globalConfiguration,
      `buy.lastBuyPriceRemoveThresholds.${quoteAsset}`,
      -1
    );

    logger.info(
      { quoteAsset, newBuyLastBuyPriceRemoveThreshold },
      'Retrieved last buy price remove threshold from global configuration'
    );

    if (newBuyLastBuyPriceRemoveThreshold === -1) {
      newBuyLastBuyPriceRemoveThreshold = parseFloat(minNotional);

      logger.info(
        { newBuyLastBuyPriceRemoveThreshold, minNotional },
        'Could not get last buy price remove threshold from global configuration. Use minimum notional from symbol info'
      );
    }
  } else {
    logger.info(
      { cachedSymbolInfo },
      'Could not find symbol info, wait to be cached.'
    );
  }

  return newBuyLastBuyPriceRemoveThreshold;
};

/**
 * Post process configuration
 * - Retrieve grid trade and determine current grid trade
 * - If symbol grid trade is stored and has executed value, then use stored grid trade.
 *
 * @param {*} logger
 * @param {*} configuration
 * @param {*} extraParams
 * @returns
 */
const postProcessConfiguration = async (
  logger,
  configuration,
  { symbolGridTrade, symbol }
) => {
  const newConfiguration = configuration;

  const lastBuyPriceDoc = await getLastBuyPrice(logger, symbol);
  const lastBuyPrice = _.get(lastBuyPriceDoc, 'lastBuyPrice', null);

  // Retrieve grid trade and determine current grid trade
  ['buy', 'sell'].forEach(side => {
    let currentGridTradeIndex = -1;
    let currentGridTrade = null;
    let overridenGridTrade = configuration[side].gridTrade;

    // If symbol grid trade is stored and has executed value at least one time
    if (
      symbolGridTrade[side] &&
      symbolGridTrade[side].some(g => g?.executed === true)
    ) {
      // Find executed grid trade
      symbolGridTrade[side].forEach((gridTrade, index) => {
        // If grid trade is executed, then override grid trade
        if (gridTrade?.executed) {
          overridenGridTrade[index] = gridTrade;
        }
      });

      // Calculate current grid trade
      overridenGridTrade.forEach((gridTrade, index) => {
        // If current grid trade is executed,
        if (gridTrade?.executed) {
          // If next gird trade exists, then get next grid trade as current buy grid trade
          if (overridenGridTrade[index + 1]) {
            currentGridTradeIndex = index + 1;
            currentGridTrade = overridenGridTrade[index + 1];
          } else {
            // If next gird trade does not exist, then do not set current grid trade
            currentGridTradeIndex = -1;
            currentGridTrade = null;
          }
        }
      });
    } else if (
      side === 'buy' &&
      lastBuyPrice > 0 &&
      overridenGridTrade[1] !== undefined
    ) {
      // If none of grid trade is executed, side is buy, last buy is recorded, 2nd grid trade is defined

      currentGridTradeIndex = 1;
      [, currentGridTrade] = overridenGridTrade;
    } else if (
      side === 'buy' &&
      lastBuyPrice > 0 &&
      overridenGridTrade[1] === undefined
    ) {
      // If none of grid trade is executed, side is buy, last buy is recorded, 2nd grid trade is not defined

      currentGridTradeIndex = -1;
      currentGridTrade = null;
    } else {
      // Otherwise, get first grid trade as current grid trade

      currentGridTradeIndex = 0;
      [currentGridTrade] = overridenGridTrade;
    }

    // Set extra parameters for grid trade if not defined
    overridenGridTrade = overridenGridTrade.map(orgGridTrade => {
      const gridTrade = orgGridTrade;
      if (gridTrade.executed === undefined) {
        gridTrade.executed = false;
        gridTrade.executedOrder = null;
      }

      return gridTrade;
    });

    // If current grid trade index is -1, then it means grid is all executed.
    newConfiguration[side].currentGridTradeIndex = currentGridTradeIndex;
    newConfiguration[side].currentGridTrade = currentGridTrade;
    newConfiguration[side].gridTrade = overridenGridTrade;
  });

  return newConfiguration;
};

/**
 * Get global/symbol configuration
 *
 * @param {*} logger
 * @param {*} symbol
 */
const getConfiguration = async (logger, symbol = null) => {
  // To reduce MongoDB query, try to get cached configuration first.
  const cachedConfiguration =
    JSON.parse(
      await cache.hget('trailing-trade-configurations', `${symbol || 'global'}`)
    ) || {};

  if (_.isEmpty(cachedConfiguration) === false) {
    return cachedConfiguration;
  }

  // If symbol is not provided, then it only looks up global configuration
  const globalConfigValue = await getGlobalConfiguration(logger);
  const symbolConfigValue = await getSymbolConfiguration(logger, symbol);
  const symbolGridTrade = await getSymbolGridTrade(logger, symbol);

  // Merge global and symbol configuration without grid trade if symbol is provided.
  let mergedConfigValue = _.defaultsDeep(
    symbolConfigValue,
    symbol !== null
      ? _.omit(globalConfigValue, 'buy.gridTrade', 'sell.gridTrade')
      : globalConfigValue
  );
  let cachedSymbolInfo;

  if (symbol !== null) {
    cachedSymbolInfo =
      JSON.parse(
        await cache.hget('trailing-trade-symbols', `${symbol}-symbol-info`)
      ) || {};

    // Post process configuration value to prefill some default values
    [
      {
        key: 'buy.gridTrade',
        keyFunc: getGridTradeBuy
      },
      {
        key: 'buy.lastBuyPriceRemoveThreshold',
        keyFunc: getLastBuyPriceRemoveThreshold
      },
      {
        key: 'sell.gridTrade',
        keyFunc: getGridTradeSell
      }
    ].forEach(d => {
      const { key, keyFunc } = d;
      _.set(
        mergedConfigValue,
        key,
        keyFunc(logger, cachedSymbolInfo, globalConfigValue, symbolConfigValue)
      );
    });

    // For symbol configuration, remove lastBuyPriceRemoveThresholds
    _.unset(mergedConfigValue, 'buy.lastBuyPriceRemoveThresholds');

    // Post process configuration to get current grid trade
    mergedConfigValue = await postProcessConfiguration(
      logger,
      mergedConfigValue,
      { symbolGridTrade, symbol }
    );
  }

  // Save final configuration to cache
  if (symbol === null || _.isEmpty(cachedSymbolInfo) === false) {
    await cache.hset(
      'trailing-trade-configurations',
      `${symbol || 'global'}`,
      JSON.stringify(mergedConfigValue)
    );
  }

  return mergedConfigValue;
};

module.exports = {
  saveGlobalConfiguration,

  getGlobalConfiguration,
  getSymbolConfiguration,
  getSymbolGridTrade,

  saveSymbolConfiguration,
  saveSymbolGridTrade,
  saveSymbolGridTradeArchive,

  deleteAllSymbolConfiguration,
  deleteSymbolConfiguration,
  deleteAllSymbolGridTrade,
  deleteSymbolGridTrade,

  getGridTradeBuy,
  getGridTradeSell,
  getLastBuyPriceRemoveThreshold,

  postProcessConfiguration,

  archiveSymbolGridTrade,
  calculateGridTradeProfit,

  getConfiguration
};
