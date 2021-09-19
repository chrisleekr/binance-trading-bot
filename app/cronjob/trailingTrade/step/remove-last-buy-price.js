const _ = require('lodash');
const moment = require('moment');
const { cache, slack, PubSub } = require('../../../helpers');
const {
  getAndCacheOpenOrdersForSymbol,
  getAPILimit,
  isActionDisabled,
  removeLastBuyPrice: removeLastBuyPriceFromDatabase,
  saveOrderStats
} = require('../../trailingTradeHelper/common');
const {
  archiveSymbolGridTrade,
  deleteSymbolGridTrade
} = require('../../trailingTradeHelper/configuration');
const { getGridTradeOrder } = require('../../trailingTradeHelper/order');

/*
 * Retrieve last grid order from cache
 *
 * @param {*} logger
 * @param {*} symbol
 * @param {*} side
 * @returns
 */
const getGridTradeLastOrder = async (logger, symbol, side) => {
  const lastOrder =
    (await getGridTradeOrder(
      logger,
      `${symbol}-grid-trade-last-${side}-order`
    )) || {};

  logger.info(
    { lastOrder },
    `Retrieved grid trade last ${side} order from cache`
  );

  return lastOrder;
};

/**
 * Remove last buy price
 *
 * @param {*} logger
 * @param {*} symbol
 * @param {*} data
 * @param {*} processMessage
 * @param {*} extraMessages
 */
const removeLastBuyPrice = async (
  logger,
  symbol,
  data,
  processMessage,
  extraMessages
) => {
  const {
    symbolConfiguration: {
      symbols,
      botOptions: {
        autoTriggerBuy: {
          enabled: autoTriggerBuyEnabled,
          triggerAfter: autoTriggerBuyTriggerAfter
        }
      }
    }
  } = data;

  // Delete the last buy price from the database
  await removeLastBuyPriceFromDatabase(logger, symbol);

  // Save number of active orders
  await saveOrderStats(logger, symbols);

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

  PubSub.publish('frontend-notification', {
    type: 'info',
    title: `The last buy price for ${symbol} has been removed.`
  });

  // Archive symbol grid trade
  const archivedGridTrade = await archiveSymbolGridTrade(logger, symbol);

  // Notify slack
  if (_.isEmpty(archivedGridTrade) === false) {
    await slack.sendMessage(
      `${symbol} ${
        archivedGridTrade.profit > 0 ? 'Profit' : 'Loss'
      } (${moment().format('HH:mm:ss.SSS')}):\n` +
        `\`\`\`` +
        ` - Profit: ${archivedGridTrade.profit}\n` +
        ` - ProfitPercentage: ${archivedGridTrade.profitPercentage}\n` +
        ` - Total Buy Amount: ${archivedGridTrade.totalBuyQuoteQty}\n` +
        ` - Total Sell Amount: ${archivedGridTrade.totalSellQuoteQty}\n` +
        `\`\`\`\n` +
        `- Current API Usage: ${getAPILimit(logger)}`
    );
  }

  // Delete symbol grid trade
  await deleteSymbolGridTrade(logger, symbol);

  if (autoTriggerBuyEnabled) {
    await cache.hset(
      'trailing-trade-override',
      `${symbol}`,
      JSON.stringify({
        action: 'buy',
        actionAt: moment().add(autoTriggerBuyTriggerAfter, 'minutes')
      })
    );

    slack.sendMessage(
      `${symbol} Action (${moment().format(
        'HH:mm:ss.SSS'
      )}): Queued buy action\n` +
        `- Message: The bot queued to trigger the grid trade for buying` +
        ` after ${autoTriggerBuyTriggerAfter} minutes later.\n` +
        `- Current API Usage: ${getAPILimit(logger)}`
    );

    PubSub.publish('frontend-notification', {
      type: 'info',
      title:
        `The bot queued to trigger the grid trade for buying` +
        ` after ${autoTriggerBuyTriggerAfter} minutes later.`
    });
  }
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

  const gridTradeLastBuyOrder = await getGridTradeLastOrder(
    logger,
    symbol,
    'buy'
  );
  if (_.isEmpty(gridTradeLastBuyOrder) === false) {
    logger.info(
      'Do not process to remove last buy price because there is a grid trade last buy order to be confirmed.'
    );
    return data;
  }

  const gridTradeLastSellOrder = await getGridTradeLastOrder(
    logger,
    symbol,
    'sell'
  );
  if (_.isEmpty(gridTradeLastSellOrder) === false) {
    logger.info(
      'Do not process to remove last buy price because there is a grid trade last sell order to be confirmed.'
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

    await removeLastBuyPrice(logger, symbol, data, processMessage, {
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

    await removeLastBuyPrice(logger, symbol, data, processMessage, {
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
