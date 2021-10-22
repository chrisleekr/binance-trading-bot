const _ = require('lodash');
const { mongo } = require('../../helpers');

/**
 * Get grid trade order
 *
 * @param {*} logger
 * @param {*} key
 * @returns
 */
const getGridTradeOrder = async (logger, key) => {
  const result = await mongo.findOne(
    logger,
    'trailing-trade-grid-trade-orders',
    {
      key
    }
  );

  return _.get(result, 'order', null);
};

/**
 * Save grid trade order
 * @param {*} logger
 * @param {*} key
 * @param {*} order
 * @returns
 */
const saveGridTradeOrder = async (logger, key, order) => {
  logger.info({ key, order }, 'The grid trade order has been saved.');

  return mongo.upsertOne(
    logger,
    'trailing-trade-grid-trade-orders',
    { key },
    { key, order }
  );
};

/**
 * Delete grid trade order
 *
 * @param {*} logger
 * @param {*} key
 * @returns
 */
const deleteGridTradeOrder = async (logger, key) => {
  logger.info({ key }, 'The grid trade order has been removed.');

  return mongo.deleteOne(logger, 'trailing-trade-grid-trade-orders', { key });
};

/**
 * Get manual trade orders by symbol
 *
 * @param {*} logger
 * @param {*} symbol
 * @returns
 */
const getManualOrders = async (logger, symbol) =>
  mongo.findAll(logger, 'trailing-trade-manual-orders', { symbol });

/**
 * Get manual trade order
 * @param {*} logger
 * @param {*} symbol
 * @returns
 */
const getManualOrder = async (logger, symbol, orderId) => {
  const result = await mongo.findOne(logger, 'trailing-trade-manual-orders', {
    symbol,
    orderId
  });

  return _.get(result, 'order', null);
};

/**
 * Save manual trade order
 *
 * @param {*} logger
 * @param {*} symbol
 * @param {*} orderId,
 * @param {*} order
 * @returns
 */
const saveManualOrder = async (logger, symbol, orderId, order) => {
  logger.info({ orderId, order }, 'The manual order has been saved.');

  return mongo.upsertOne(
    logger,
    'trailing-trade-manual-orders',
    { symbol, orderId },
    { symbol, orderId, order }
  );
};

/**
 * Delete manual trade order
 *
 * @param {*} logger
 * @param {*} symbol
 * @param {*} orderId
 * @returns
 */
const deleteManualOrder = async (logger, symbol, orderId) => {
  logger.info({ orderId }, 'The manual order has been removed.');

  return mongo.deleteOne(logger, 'trailing-trade-manual-orders', {
    symbol,
    orderId
  });
};

module.exports = {
  getGridTradeOrder,
  saveGridTradeOrder,
  deleteGridTradeOrder,
  getManualOrders,
  getManualOrder,
  saveManualOrder,
  deleteManualOrder
};
