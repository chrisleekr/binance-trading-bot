const _ = require('lodash');
const moment = require('moment-timezone');
const { cache, mongo } = require('../../../helpers');
/**
 * Get quote asset statistics
 *
 * @param {*} logger
 * @param {*} rawData
 */
const execute = async (logger, rawData) => {
  const data = rawData;

  const { symbolInfo } = rawData;

  const { quoteAsset } = symbolInfo;

  const closedTradesSetting =
    JSON.parse(await cache.hget('trailing-trade-common', 'closed-trades')) ||
    {};

  const selectedPeriod = _.get(closedTradesSetting, 'selectedPeriod', 'a');
  const selectedPeriodTZ = _.get(
    closedTradesSetting,
    'selectedPeriodTZ',
    'UTC'
  );
  const selectedPeriodLC = _.get(closedTradesSetting, 'selectedPeriodLC', 'us');

  let start = null;
  let end = null;

  const momentLocale = moment.tz(selectedPeriodTZ).locale(selectedPeriodLC);
  switch (selectedPeriod) {
    case 'd':
      start = momentLocale.startOf('day').toISOString();
      end = momentLocale.endOf('day').toISOString();
      break;
    case 'w':
      start = momentLocale.startOf('week').toISOString();
      end = momentLocale.endOf('week').toISOString();
      break;
    case 'm':
      start = momentLocale.startOf('month').toISOString();
      end = momentLocale.endOf('month').toISOString();
      break;
    case 'a':
    default:
  }

  const match = {};

  if (start && end) {
    match.archivedAt = {
      $gte: start,
      $lte: end
    };
  }

  const closedTrades = (
    await mongo.aggregate(logger, 'trailing-trade-grid-trade-archive', [
      {
        $match: { quoteAsset, ...match }
      },
      {
        $group: {
          _id: '$quoteAsset',
          quoteAsset: { $first: '$quoteAsset' },
          totalBuyQuoteQty: { $sum: '$totalBuyQuoteQty' },
          totalSellQuoteQty: { $sum: '$totalSellQuoteQty' },
          buyGridTradeQuoteQty: { $sum: '$buyGridTradeQuoteQty' },
          buyManualQuoteQty: { $sum: '$buyManualQuoteQty' },
          sellGridTradeQuoteQty: { $sum: '$sellGridTradeQuoteQty' },
          sellManualQuoteQty: { $sum: '$sellManualQuoteQty' },
          stopLossQuoteQty: { $sum: '$stopLossQuoteQty' },
          profit: { $sum: '$profit' },
          trades: { $sum: 1 },
          lastProfit: { $last: '$profit' },
          lastSymbol: { $last: '$symbol' },
          lastArchivedAt: { $last: '$archivedAt' }
        }
      },
      {
        $project: {
          quoteAsset: 1,
          totalBuyQuoteQty: 1,
          totalSellQuoteQty: 1,
          buyGridTradeQuoteQty: 1,
          buyManualQuoteQty: 1,
          sellGridTradeQuoteQty: 1,
          sellManualQuoteQty: 1,
          stopLossQuoteQty: 1,
          profit: 1,
          profitPercentage: {
            $cond: {
              if: {
                $gt: ['$totalBuyQuoteQty', 0]
              },
              then: {
                $multiply: [
                  {
                    $divide: ['$profit', '$totalBuyQuoteQty']
                  },
                  100
                ]
              },
              else: 0
            }
          },
          trades: 1,
          lastProfit: 1,
          lastSymbol: 1,
          lastArchivedAt: 1
        }
      }
    ])
  )[0] || {
    quoteAsset,
    totalBuyQuoteQty: 0,
    totalSellQuoteQty: 0,
    buyGridTradeQuoteQty: 0,
    buyManualQuoteQty: 0,
    sellGridTradeQuoteQty: 0,
    sellManualQuoteQty: 0,
    stopLossQuoteQty: 0,
    profit: 0,
    profitPercentage: 0,
    trades: 0,
    lastProfit: 0,
    lastSymbol: '',
    lastArchivedAt: ''
  };

  data.closedTrades = closedTrades;

  await cache.hset(
    'trailing-trade-common',
    'closed-trades',
    JSON.stringify({
      ...closedTradesSetting,
      loadedPeriod: selectedPeriod,
      loadedPeriodTZ: selectedPeriodTZ,
      loadedPeriodLC: selectedPeriodLC
    })
  );

  return data;
};

module.exports = { execute };
