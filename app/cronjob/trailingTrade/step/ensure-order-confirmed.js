/* eslint-disable no-await-in-loop */
const moment = require('moment');
const _ = require('lodash');
const config = require('config');
const { cache, PubSub, binance, messenger } = require('../../../helpers');
const {
  getLastBuyPrice,
  saveLastBuyPrice,
  getAPILimit,
  isActionDisabled
} = require('../../trailingTradeHelper/common');

/**
 * Retrieve last buy price and recalculate new last buy price
 *
 * @param {*} logger
 * @param {*} symbol
 * @param {*} order
 */
const calculateLastBuyPrice = async (logger, symbol, order) => {

  const { origQty, price } = order;
  messenger.errorMessage("Trying to setup last buy price")
  const lastBuyPriceDoc = await getLastBuyPrice(logger, symbol);
  const orgLastBuyPrice = _.get(lastBuyPriceDoc, 'lastBuyPrice', 0);
  const orgQuantity = _.get(lastBuyPriceDoc, 'quantity', 0);
  const orgTotalAmount = orgLastBuyPrice * orgQuantity;

  logger.info(
    { orgLastBuyPrice, orgQuantity, orgTotalAmount },
    'Existing last buy price'
  );

  const filledQuoteQty = parseFloat(price);
  const filledQuantity = parseFloat(origQty);

  const newQuantity = (orgQuantity + filledQuantity);
  const newTotalAmount = (orgTotalAmount + filledQuoteQty);

  const newLastBuyPrice = (newTotalAmount / newQuantity);

  messenger.errorMessage("New last buy: " + newLastBuyPrice);

  messenger.errorMessage("New qty: " + newQuantity);

  logger.info(
    { newLastBuyPrice, newTotalAmount, newQuantity },
    'New last buy price'
  );
  await saveLastBuyPrice(logger, symbol, {
    lastBuyPrice: newLastBuyPrice,
    quantity: newQuantity,
    lastBoughtPrice: price
  });

  await cache.hdel(`${symbol}-last-buy-order`);

  messenger.errorMessage("Done.")
  PubSub.publish('frontend-notification', {
    type: 'success',
    title: `New last buy price for ${symbol} has been updated.`
  });
};

/**
 * Ensure manual buy order is placed
 *
 * @param {*} logger
 * @param {*} rawData
 */
const execute = async (logger, rawData) => {
  const data = rawData;

  return data;
  const {
    symbol,
    symbolConfiguration: {
      system: { checkManualBuyOrderPeriod }
    }
  } = data;

  if (await isActionDisabled(symbol)) {
    logger.info(
      'Action is disabled. I cant verify the order.'
    );
    return data;
  }

  const retrievedOrder = await cache.hgetall(
    `${symbol}-last-buy-order`
  );

  if (_.isEmpty(retrievedOrder) === true) {
    logger.info(
      { retrievedOrder },
      'Could not find manual buy order, do not process ensure-manual-buy-order.'
    );
    return data;
  }

  const removeStatuses = ['CANCELED', 'REJECTED', 'EXPIRED', 'PENDING_CANCEL'];

  const buyOrder = JSON.parse(Object.values(retrievedOrder));

  // If not filled, check orders is time to check or not
  if (buyOrder.status === 'FILLED') {
    logger.info(
      { buyOrder },
      'Order has already filled, calculate last buy price.'
    );
    await calculateLastBuyPrice(logger, symbol, buyOrder);
  } else {
    const nextCheck = _.get(buyOrder, 'nextCheck', null);

    if (moment(nextCheck) < moment()) {
      // Check orders whether it's filled or not
      let orderResult;
      try {
        orderResult = await binance.client.getOrder({
          symbol,
          orderId: buyOrder.orderId
        });
      } catch (e) {
        logger.error(
          { e },
          'The order could not be found or error occurred querying the order.'
        );
        const updatedNextCheck = moment().add(
          checkManualBuyOrderPeriod,
          'seconds'
        );

        logger.info(
          {
            e,
            buyOrder,
            checkManualBuyOrderPeriod,
            nextCheck: updatedNextCheck
          },
          'The order could not be found or error occurred querying the order.'
        );

        await cache.hset(
          `${symbol}-last-buy-order`,
          buyOrder.orderId,
          JSON.stringify({
            ...buyOrder,
            nextCheck: updatedNextCheck
          })
        );

        return data;
      }

      // If filled, then calculate average cost and quantity and save new last buy pirce.
      if (orderResult.status === 'FILLED') {

        messenger.errorMessage("Order filled")
        logger.info(
          { buyOrder },
          'The order is filled, caluclate last buy price.'
        );

        await calculateLastBuyPrice(logger, symbol, buyOrder);
      } else if (removeStatuses.includes(orderResult.status) === true) {
        // If order is no longer available, then delete from cache
        await cache.hdel(
          `${symbol}-last-buy-order`
        );


      } else {
        // If not filled, update next check time
        const updatedNextCheck = moment().add(
          checkManualBuyOrderPeriod,
          'seconds'
        );

        logger.info(
          {
            orderResult,
            checkManualBuyOrderPeriod,
            nextCheck: updatedNextCheck
          },
          'The order is not filled, update next check time.'
        );

        await cache.hset(
          `${symbol}-last-buy-order`,
          orderResult.orderId,
          JSON.stringify({
            ...orderResult,
            nextCheck: updatedNextCheck
          })
        );
      }
    } else {
      logger.info(
        { buyOrder, nextCheck, currentTime: moment() },
        'Skip checking the order'
      );
    }
  }

  messenger.errorMessage(JSON.stringify(buyOrder))



  return data;
};

module.exports = { execute };
