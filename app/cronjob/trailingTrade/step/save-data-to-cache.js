const _ = require('lodash');
const { mongo } = require('../../../helpers');

/**
 * Save data to cache
 *
 * @param {*} logger
 * @param {*} rawData
 */
const execute = async (logger, rawData) => {
  const data = rawData;

  const { symbol, saveToCache } = data;

  if (saveToCache !== true) {
    logger.info(
      { saveToCache },
      'Saving to cache is not approved. Do not save to cache'
    );
    return data;
  }

  const filter = { symbol };

  const document = _.omit(data, [
    'closedTrades',
    'accountInfo',
    'symbolConfiguration.symbols',
    'tradingView'
  ]);

  await mongo.upsertOne(logger, 'trailing-trade-cache', filter, document);

  return data;
};

module.exports = { execute };
