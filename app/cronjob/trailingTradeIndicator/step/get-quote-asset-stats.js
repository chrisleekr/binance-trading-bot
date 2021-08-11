const { mongo } = require('../../../helpers');
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

  const quoteAssetStats = (
    await mongo.aggregate(logger, 'trailing-trade-grid-trade-archive', [
      {
        $match: { quoteAsset }
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
          trades: { $sum: 1 }
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
            $multiply: [{ $divide: ['$profit', '$totalBuyQuoteQty'] }, 100]
          },
          trades: 1
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
    trades: 0
  };

  data.quoteAssetStats = quoteAssetStats;

  return data;
};

module.exports = { execute };
