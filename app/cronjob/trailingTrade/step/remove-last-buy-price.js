const _ = require('lodash');
const moment = require('moment');
const { mongo, cache, messenger } = require('../../../helpers');
const { isActionDisabled } = require('../../trailingTradeHelper/common');
/**
 * Retrieve last buy order from cache
 *
 * @param {*} logger
 * @param {*} symbol
 * @returns
 */

const getLastBuyOrder = async (logger, symbol) => {
  const cachedLastBuyOrder =
    JSON.parse(await cache.get(`${symbol}-last-buy-order`)) || {};

  logger.info({ cachedLastBuyOrder }, 'Retrieved last buy order from cache');

  return cachedLastBuyOrder;
};

const getLastSellOrder = async (logger, symbol) => {
  const cachedLastSellOrder =
    JSON.parse(await cache.get(`${symbol}-last-sell-order`)) || {};

  logger.info({ cachedLastSellOrder }, 'Retrieved last buy order from cache');

  return cachedLastSellOrder;
};

/**
 * Remove last buy price
 *
 * @param {*} logger
 * @param {*} symbol
 * @param {*} processMessage
 * @param {*} extraMessages
 */
const removeLastBuyPrice = async (logger, symbol) => {
  await mongo.deleteOne(logger, 'trailing-trade-symbols', {
    key: `${symbol}-last-buy-price`
  });

  // messenger.sendMessage(
  //  symbol, null, 'REMOVE_LAST_BUY');
};

/**
 * Remove last buy price if applicable
 *
 * @param {*} logger
 * @param {*} rawData
 */
const execute = async (logger, rawData) => {
  const data = rawData;

  const {
    isLocked,
    action,
    symbol,
    symbolConfiguration: {
      buy: { lastBuyPriceRemoveThreshold }
    },
    symbolInfo: {
      filterLotSize: { stepSize },
      filterMinNotional: { minNotional }
    },
    openOrders,
    baseAssetBalance: {
      free: baseAssetFreeBalance,
      locked: baseAssetLockedBalance
    },
    sell: { currentPrice, lastBuyPrice, lastQtyBought }
  } = data;

  if (isLocked) {
    logger.info(
      { isLocked },
      'Symbol is locked, do not process remove-last-buy-price'
    );
    return data;
  }

  if (action !== 'not-determined') {
    logger.info('Do not process to remove last buy price.');
    return data;
  }

  // If last buy price is null, undefined, 0, NaN or less than 0
  if (!lastBuyPrice || lastBuyPrice <= 0) {
    logger.info('Do not process because last buy price does not exist.');
    return data;
  }

  // If last buy price is null, undefined, 0, NaN or less than 0
  if (!lastQtyBought || lastQtyBought <= 0) {
    logger.info('Do not process because last qty bought does not exist.');
    return data;
  }

  if (_.isEmpty(openOrders) === false) {
    logger.info('Do not remove last buy price in case the order is related.');
    return data;
  }

  const checkDisable = await isActionDisabled(symbol);
  logger.info(
    { tag: 'check-disable', checkDisable },
    'Checked whether symbol is disabled or not.'
  );
  if (checkDisable.isDisabled && checkDisable.canRemoveLastBuyPrice === false) {
    logger.info('Do not remove last buy price because action is disabled.');
    return data;
  }

  // Check one last time for open orders to make sure.
  const lotPrecision = parseFloat(stepSize) === 1 ? 0 : stepSize.indexOf(1) - 1;

  let totalBaseAssetBalance;
  if (lastQtyBought === 0 || lastQtyBought == null) {
    totalBaseAssetBalance =
      parseFloat(baseAssetFreeBalance) + parseFloat(baseAssetLockedBalance);
  } else {
    totalBaseAssetBalance =
      parseFloat(lastQtyBought) + parseFloat(baseAssetLockedBalance);
  }

  const baseAssetQuantity = parseFloat(
    _.floor(
      (totalBaseAssetBalance - totalBaseAssetBalance) * (0.1 / 100),
      lotPrecision
    )
  );

  // One more verify
  const lastBuyOrder = await getLastBuyOrder(logger, symbol);
  if (_.isEmpty(lastBuyOrder) === false) {
    logger.info(
      'Do not process to remove last buy price because there is a buy order to be confirmed.'
    );
    return data;
  }

  const lastSellOrder = await getLastSellOrder(logger, symbol);
  if (_.isEmpty(lastSellOrder) === false) {
    logger.info(
      'Do not process to remove last buy price because there is a buy order to be confirmed.'
    );
    return data;
  }

  let processMessage = '';

  /* const refreshedOpenOrders = [];
     if (baseAssetQuantity <= parseFloat(minQty)) {
      // Final check for open orders
      refreshedOpenOrders = await getAndCacheOpenOrdersForSymbol(logger, symbol);
      if (refreshedOpenOrders.length > 0) {
        logger.info('Do not remove last buy price. Found open orders.');
        return data;
      }


      messenger.errorMessage("Removed last buy price by min quantity. " + symbol)
      processMessage = 'Balance is not enough to sell. Delete last buy price.';

      logger.error(
        { baseAssetQuantity },

        processMessage
      );

      data.sell.processMessage = processMessage;
      data.sell.updatedAt = moment().utc();

      await removeLastBuyPrice(logger, symbol, processMessage, {
        lastBuyPrice,
        baseAssetQuantity,
        minQty,
        baseAssetFreeBalance,
        baseAssetLockedBalance,
        totalBaseAssetBalance,
        openOrders
      });

      return data;
    }
  */

  if (baseAssetQuantity * currentPrice < parseFloat(minNotional)) {
    messenger.errorMessage(`Removed last buy price by min notional. ${symbol}`);

    processMessage =
      'Balance is less than the notional value. Delete last buy price.';

    logger.error({ baseAssetQuantity }, processMessage);

    data.sell.processMessage = processMessage;
    data.sell.updatedAt = moment().utc();

    await removeLastBuyPrice(logger, symbol, processMessage, {
      lastBuyPrice,
      baseAssetQuantity,
      currentPrice,
      minNotional,
      openOrders
    });

    return data;
  }

  if (baseAssetQuantity * currentPrice < lastBuyPriceRemoveThreshold) {
    messenger.errorMessage('Removed last buy price by last threshold.');

    processMessage =
      'Balance is less than the notional value. Delete last buy price.';

    logger.error({ baseAssetQuantity }, processMessage);

    data.sell.processMessage = processMessage;
    data.sell.updatedAt = moment().utc();

    await removeLastBuyPrice(logger, symbol, processMessage, {
      lastBuyPrice,
      baseAssetQuantity,
      currentPrice,
      minNotional,
      openOrders
    });

    return data;
  }

  return data;
};

module.exports = { execute };
