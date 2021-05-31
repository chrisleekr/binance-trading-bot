const _ = require('lodash');
const { cache, mongo, PubSub } = require('../../../helpers');
const {
  getAccountInfo,
  saveLastBuyPrice
} = require('../../../cronjob/trailingTradeHelper/common');

/**
 * Delete last buy price
 *
 * @param {*} logger
 * @param {*} ws
 * @param {*} symbol
 * @returns
 */
const deleteLastBuyPrice = async (logger, ws, symbol) => {
  await mongo.deleteOne(logger, 'trailing-trade-symbols', {
    key: `${symbol}-last-buy-price`
  });

  PubSub.publish('frontend-notification', {
    type: 'success',
    title: `The last buy price for ${symbol} has been removed successfully.`
  });

  ws.send(
    JSON.stringify({
      result: true,
      type: 'symbol-update-result',
      message: `The last buy price for ${symbol} has been removed successfully.`
    })
  );

  return true;
};

/**
 * Update last buy price
 *
 * @param {*} logger
 * @param {*} ws
 * @param {*} symbol
 * @param {*} lastBuyPrice
 * @returns
 */
const updateLastBuyPrice = async (logger, ws, symbol, lastBuyPrice) => {
  // Retrieve symbol info
  const cachedSymbolInfo =
    JSON.parse(
      await cache.hget('trailing-trade-symbols', `${symbol}-symbol-info`)
    ) || {};

  if (_.isEmpty(cachedSymbolInfo) === true) {
    PubSub.publish('frontend-notification', {
      type: 'error',
      title:
        `The bot could not retrieve the cached symbol information for ${symbol}.` +
        ` Wait for the symbol information to be cached and try again.`
    });

    ws.send(
      JSON.stringify({
        result: false,
        type: 'symbol-update-last-buy-price-result',
        message:
          `The bot could not retrieve the cached symbol information for ${symbol}.` +
          ` Wait for the symbol information to be cached and try again.`
      })
    );
    return false;
  }

  const { baseAsset } = cachedSymbolInfo;
  // Retrieve account info from cache
  const accountInfo = await getAccountInfo(logger);

  // Get asset balances
  const baseAssetBalance = accountInfo.balances.filter(
    b => b.asset === baseAsset
  )[0] || {
    asset: baseAsset,
    free: 0,
    locked: 0,
    total: 0,
    estimatedValue: 0
  };

  // Calculate total quantity
  const baseAssetTotalBalance =
    parseFloat(baseAssetBalance.free) + parseFloat(baseAssetBalance.locked);

  await saveLastBuyPrice(logger, symbol, {
    lastBuyPrice,
    quantity: baseAssetTotalBalance
  });

  PubSub.publish('frontend-notification', {
    type: 'success',
    title: `The last buy price for ${symbol} has been configured successfully.`
  });

  ws.send(
    JSON.stringify({
      result: true,
      type: 'symbol-update-result',
      message: `The last buy price for ${symbol} has been configured successfully.`
    })
  );

  return true;
};

const handleSymbolUpdateLastBuyPrice = async (logger, ws, payload) => {
  logger.info({ payload }, 'Start symbol update');

  const { data: symbolInfo } = payload;

  // Update last-buy-price
  const { symbol } = symbolInfo;
  const { lastBuyPrice } = symbolInfo.sell;

  if (parseFloat(lastBuyPrice) <= 0) {
    return deleteLastBuyPrice(logger, ws, symbol);
  }

  return updateLastBuyPrice(logger, ws, symbol, lastBuyPrice);
};

module.exports = { handleSymbolUpdateLastBuyPrice };
