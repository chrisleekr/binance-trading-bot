const _ = require('lodash');
const moment = require('moment');
const { mongo, cache, slack } = require('../../../helpers');
const {
  getAndCacheOpenOrdersForSymbol,
  getAPILimit,
  isActionDisabled
} = require('../../trailingTradeHelper/common');
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

/**
 * Remove last buy price
 *
 * @param {*} logger
 * @param {*} symbol
 * @param {*} processMessage
 * @param {*} extraMessages
 */
const removeLastBuyPrice = async (
  logger,
  symbol,
  processMessage,
  extraMessages
) => {
  await mongo.deleteOne(logger, 'trailing-trade-symbols', {
    key: `${symbol}-last-buy-price`
  });

  slack.sendMessage(
    `${symbol} Action (${moment().format(
      'HH:mm:ss.SSS'
    )}): Removed last buy price\n` +
      `- Message: ${processMessage}\n\`\`\`${JSON.stringify(
        extraMessages,
        undefined,
        2
      )}\`\`\`\n` +
      `- Current API Usage: ${getAPILimit(logger)}`
  );
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
      filterLotSize: { stepSize, minQty },
      filterMinNotional: { minNotional }
    },
    openOrders,
    baseAssetBalance: {
      free: baseAssetFreeBalance,
      locked: baseAssetLockedBalance
    },
    sell: { currentPrice, lastBuyPrice }
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

  const lastBuyOrder = await getLastBuyOrder(logger, symbol);
  if (_.isEmpty(lastBuyOrder) === false) {
    logger.info(
      'Do not process to remove last buy price because there is a buy order to be confirmed.'
    );
    return data;
  }

  // If last buy price is null, undefined, 0, NaN or less than 0
  if (!lastBuyPrice || lastBuyPrice <= 0) {
    logger.info('Do not process because last buy price does not exist.');
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

  const totalBaseAssetBalance =
    parseFloat(baseAssetFreeBalance) + parseFloat(baseAssetLockedBalance);

  const baseAssetQuantity = parseFloat(
    _.floor(
      totalBaseAssetBalance - totalBaseAssetBalance * (0.1 / 100),
      lotPrecision
    )
  );

  let processMessage = '';

  let refreshedOpenOrders = [];
  if (baseAssetQuantity <= parseFloat(minQty)) {
    // Final check for open orders
    refreshedOpenOrders = await getAndCacheOpenOrdersForSymbol(logger, symbol);
    if (refreshedOpenOrders.length > 0) {
      logger.info('Do not remove last buy price. Found open orders.');
      return data;
    }

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

  if (baseAssetQuantity * currentPrice < lastBuyPriceRemoveThreshold) {
    // Final check for open orders
    refreshedOpenOrders = await getAndCacheOpenOrdersForSymbol(logger, symbol);
    if (refreshedOpenOrders.length > 0) {
      logger.info('Do not remove last buy price. Found open orders.');
      return data;
    }

    processMessage =
      'Balance is less than the last buy price remove threshold. Delete last buy price.';

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
