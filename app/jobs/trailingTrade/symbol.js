const _ = require('lodash');
const { mongo } = require('../../helpers');

/**
 * Get last buy price from mongodb
 *
 * @param {*} logger
 * @param {*} symbol
 */
const getLastBuyPrice = async (logger, symbol) => {
  const lastBuyPriceDoc = await mongo.findOne(
    logger,
    'trailing-trade-symbols',
    {
      key: `${symbol}-last-buy-price`
    }
  );

  const cachedLastBuyPrice = _.get(lastBuyPriceDoc, 'lastBuyPrice', null);
  logger.debug({ cachedLastBuyPrice }, 'Last buy price');

  return cachedLastBuyPrice;
};

module.exports = { getLastBuyPrice };
