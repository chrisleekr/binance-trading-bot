const _ = require('lodash');
const moment = require('moment');
const { slack, PubSub, binance } = require('../../../helpers');
const {
  getAPILimit,
  isActionDisabled,
  removeLastBuyPrice: removeLastBuyPriceFromDatabase,
  saveOrderStats,
  saveOverrideAction,
  getAndCacheOpenOrdersForSymbol
} = require('../../trailingTradeHelper/common');
const {
  archiveSymbolGridTrade,
  deleteSymbolGridTrade,
  getSymbolGridTrade
} = require('../../trailingTradeHelper/configuration');
const { getGridTradeOrder } = require('../../trailingTradeHelper/order');

/**
 * Check if base quantity is less than minimum quantity
 *
 * @param {*} param0
 * @returns
 */
const isLessThanMinimumQuantity = ({ baseAssetQuantity, minQty }) =>
  baseAssetQuantity <= parseFloat(minQty);

/**
 * Check if remained amount is less than last buy price remove threshold
 *
 * @param {*} param0
 * @returns
 */
const isLessThanLastBuyPriceRemoveThreshold = ({
  baseAssetQuantity,
  currentPrice,
  lastBuyPriceRemoveThreshold
}) => baseAssetQuantity * currentPrice < lastBuyPriceRemoveThreshold;

/**
 * Check if sell order is completed
 *
 * @param {*} logger
 * @param {*} symbol
 * @returns
 */
const isSellOrderCompleted = async (logger, symbol) => {
  // Get trade order
  const gridTrade = await getSymbolGridTrade(logger, symbol);
  if (_.isEmpty(gridTrade)) {
    logger.info('There is no grid trade for the symbol. Do not process.');
    return false;
  }

  const { sell } = gridTrade;
  if (_.isEmpty(sell)) {
    logger.info(
      'There is no sell order in the grid trade for the symbol. Do not process.'
    );
    return false;
  }

  const allExecuted = _.every(sell, s => s.executed);
  if (allExecuted) {
    logger.info(
      { sell, allExecuted },
      'All sell orders are executed. Delete last buy price.'
    );
    return true;
  }

  logger.info(
    { sell, allExecuted },
    'There is unexecuted sell order. Do not process.'
  );
  return false;
};

/**
 * Set message and return data
 *
 * @param {*} logger
 * @param {*} rawData
 * @param {*} processMessage
 * @returns
 */
const setMessage = (logger, rawData, processMessage) => {
  const data = rawData;

  logger.info({ data, saveLog: true }, processMessage);
  data.sell.processMessage = processMessage;
  data.sell.updatedAt = moment().utc().toDate();
  return data;
};

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
    `*${symbol}* Action - Removed last buy price:\n` +
      `- Message: ${processMessage}\n\`\`\`${JSON.stringify(
        extraMessages,
        undefined,
        2
      )}\`\`\``,
    { symbol, apiLimit: getAPILimit(logger) }
  );

  PubSub.publish('frontend-notification', {
    type: 'info',
    title: `The last buy price for ${symbol} has been removed.`
  });

  // Archive symbol grid trade
  const archivedGridTrade = await archiveSymbolGridTrade(logger, symbol);

  // Notify slack
  if (_.isEmpty(archivedGridTrade) === false) {
    slack.sendMessage(
      `*${symbol}* ${archivedGridTrade.profit > 0 ? 'Profit' : 'Loss'}:\n` +
        `\`\`\`` +
        ` - Profit: ${archivedGridTrade.profit}\n` +
        ` - ProfitPercentage: ${archivedGridTrade.profitPercentage}\n` +
        ` - Total Buy Amount: ${archivedGridTrade.totalBuyQuoteQty}\n` +
        ` - Total Sell Amount: ${archivedGridTrade.totalSellQuoteQty}\n` +
        `\`\`\``,
      { symbol, apiLimit: getAPILimit(logger) }
    );
  }

  // Delete symbol grid trade
  await deleteSymbolGridTrade(logger, symbol);

  if (autoTriggerBuyEnabled) {
    await saveOverrideAction(
      logger,
      symbol,
      {
        action: 'buy',
        actionAt: moment()
          .add(autoTriggerBuyTriggerAfter, 'minutes')
          .toISOString(),
        triggeredBy: 'auto-trigger',
        notify: true,
        checkTradingView: true
      },
      `The bot queued the action to trigger the grid trade for buying` +
        ` after ${autoTriggerBuyTriggerAfter} minutes later.`
    );
  }
};

/**
 * Process removing last buy price
 *
 * @param {*} logger
 * @param {*} symbol
 * @param {*} data
 * @param {*} processMessage
 * @param {*} extraMessages
 * @returns
 */
const processRemoveLastBuyPrice = async (
  logger,
  symbol,
  data,
  processMessage,
  extraMessages
) => {
  const refreshedOpenOrders = await getAndCacheOpenOrdersForSymbol(
    logger,
    symbol
  );
  if (refreshedOpenOrders.length > 0) {
    await Promise.all(
      refreshedOpenOrders.map(order =>
        binance.client.cancelOrder({
          symbol,
          orderId: order.orderId
        })
      )
    );
    logger.info(
      { refreshedOpenOrders, saveLog: true },
      'Cancelled all open orders before removing the last buy price.'
    );
    // Cache again.
    await getAndCacheOpenOrdersForSymbol(logger, symbol);
  }

  await removeLastBuyPrice(logger, symbol, data, processMessage, extraMessages);

  return setMessage(logger, data, processMessage);
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

  if (['not-determined', 'buy-order-wait'].includes(action) === false) {
    logger.info(
      `Do not process to remove last buy price due to the ${action} action.`
    );
    return data;
  }

  // If last buy price is null, undefined, 0, NaN or less than 0.
  if (!lastBuyPrice || lastBuyPrice <= 0) {
    logger.info('Do not process because last buy price does not exist.');
    return data;
  }

  // If the action is disabled, then do not process.
  const checkDisable = await isActionDisabled(symbol);
  logger.info(
    { tag: 'check-disable', checkDisable },
    'Checked whether symbol is disabled or not.'
  );

  if (checkDisable.isDisabled && checkDisable.canRemoveLastBuyPrice === false) {
    logger.info('Do not remove last buy price because action is disabled.');
    return data;
  }

  // If there is open order for grid trade sell order, then do not process.
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

  let processMessage = '';

  if (await isSellOrderCompleted(logger, symbol)) {
    processMessage = 'All sell orders are executed. Delete last buy price.';

    logger.info(processMessage);

    return processRemoveLastBuyPrice(logger, symbol, data, processMessage, {
      lastBuyPrice,
      currentPrice,
      minNotional,
      openOrders
    });
  }

  const lotPrecision = parseFloat(stepSize) === 1 ? 0 : stepSize.indexOf(1) - 1;

  const totalBaseAssetBalance =
    parseFloat(baseAssetFreeBalance) + parseFloat(baseAssetLockedBalance);

  const baseAssetQuantity = parseFloat(
    _.floor(
      totalBaseAssetBalance - totalBaseAssetBalance * (0.1 / 100),
      lotPrecision
    )
  );

  if (isLessThanMinimumQuantity({ baseAssetQuantity, minQty })) {
    processMessage = 'Balance is not enough to sell. Delete last buy price.';

    logger.info(
      { baseAssetQuantity },

      processMessage
    );

    return processRemoveLastBuyPrice(logger, symbol, data, processMessage, {
      lastBuyPrice,
      baseAssetQuantity,
      minQty,
      baseAssetFreeBalance,
      baseAssetLockedBalance,
      totalBaseAssetBalance,
      openOrders
    });
  }

  if (
    isLessThanLastBuyPriceRemoveThreshold({
      baseAssetQuantity,
      currentPrice,
      lastBuyPriceRemoveThreshold
    })
  ) {
    processMessage =
      'Balance is less than the last buy price remove threshold. Delete last buy price.';

    logger.info({ baseAssetQuantity }, processMessage);

    return processRemoveLastBuyPrice(logger, symbol, data, processMessage, {
      lastBuyPrice,
      baseAssetQuantity,
      currentPrice,
      minNotional,
      openOrders
    });
  }

  return data;
};

module.exports = { execute };
