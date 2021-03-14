const _ = require('lodash');
const moment = require('moment');
const { mongo } = require('../../../helpers');
/**
 * Remove last buy price if applicable
 *
 * @param {*} logger
 * @param {*} rawData
 */
const execute = async (logger, rawData) => {
  const data = rawData;

  const {
    action,
    symbol,
    symbolInfo: {
      filterLotSize: { stepSize, minQty },
      filterMinNotional: { minNotional }
    },
    baseAssetBalance: {
      free: baseAssetFreeBalance,
      locked: baseAssetLockedBalance
    },
    sell: { currentPrice, lastBuyPrice }
  } = data;

  if (action !== 'not-determined') {
    logger.info('Do not process to remove last buy price.');
    return data;
  }

  if (lastBuyPrice <= 0) {
    logger.info('Do not process because last buy price does not exist.');
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

    return data;
  }

  return data;
};

module.exports = { execute };
