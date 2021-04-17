const _ = require('lodash');
const moment = require('moment');
const { mongo, cache, slack } = require('../../../helpers');

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

  const lotPrecision = stepSize.indexOf(1) - 1;

  const totalBaseAssetBalance =
    parseFloat(baseAssetFreeBalance) + parseFloat(baseAssetLockedBalance);

  const baseAssetQuantity = parseFloat(
    _.floor(
      totalBaseAssetBalance - totalBaseAssetBalance * (0.1 / 100),
      lotPrecision
    )
  );

  if (baseAssetQuantity <= parseFloat(minQty)) {
    logger.error(
      { baseAssetQuantity },

      'Balance is found; however, not enough to sell. Delete last buy price.'
    );
    await mongo.deleteOne(logger, 'trailing-trade-symbols', {
      key: `${symbol}-last-buy-price`
    });

    data.sell.processMessage =
      'Balance is found; however, not enough to sell. Delete last buy price.';
    data.sell.updatedAt = moment().utc();

    await slack.sendMessage(
      `Action (${moment().format(
        'HH:mm:ss.SSS'
      )}): Removed last buy price\n- Symbol: ${symbol}\n- Message: ${
        data.sell.processMessage
      }\n\`\`\`${JSON.stringify(
        {
          lastBuyPrice,
          baseAssetQuantity,
          minQty,
          baseAssetFreeBalance,
          baseAssetLockedBalance,
          totalBaseAssetBalance
        },
        undefined,
        2
      )}\`\`\``
    );

    return data;
  }

  if (baseAssetQuantity * currentPrice < parseFloat(minNotional)) {
    logger.error(
      { baseAssetQuantity },
      'Balance is found; however, the balance is less than the notional value. Delete last buy price.'
    );
    await mongo.deleteOne(logger, 'trailing-trade-symbols', {
      key: `${symbol}-last-buy-price`
    });
    data.sell.processMessage =
      'Balance is found; however, the balance is less than the notional value. Delete last buy price.';
    data.sell.updatedAt = moment().utc();

    await slack.sendMessage(
      `Action (${moment().format(
        'HH:mm:ss.SSS'
      )}): Removed last buy price\n- Symbol: ${symbol}\n- Message: ${
        data.sell.processMessage
      }\n\`\`\`${JSON.stringify(
        {
          lastBuyPrice,
          baseAssetQuantity,
          currentPrice,
          minNotional
        },
        undefined,
        2
      )}\`\`\``
    );

    return data;
  }

  return data;
};

module.exports = { execute };
