const {
  verifyAuthenticated
} = require('../../../cronjob/trailingTradeHelper/common');

const { mongo } = require('../../../helpers');

const handleGridTradeArchiveGetByQuoteAsset = async (funcLogger, app) => {
  const logger = funcLogger.child({
    endpoint: '/grid-trade-archive-by-quote-asset'
  });
  app.route('/grid-trade-archive-by-quote-asset').post(async (req, res) => {
    const { authToken, quoteAsset, page, limit } = req.body;

    // Verify authentication
    logger.info({ page, limit }, 'Grid Trade Archive');

    const isAuthenticated = await verifyAuthenticated(logger, authToken);
    if (isAuthenticated === false) {
      logger.info('Not authenticated');
      return res.send({
        success: false,
        status: 403,
        message: 'Please authenticate first.',
        data: {
          rows: [],
          stats: {}
        }
      });
    }

    const rows = await mongo.findAll(
      logger,
      'trailing-trade-grid-trade-archive',
      {
        quoteAsset
      },
      {
        sort: { archivedAt: -1 },
        skip: (page - 1) * limit,
        limit
      }
    );

    const stats = (
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

    return res.send({
      success: true,
      status: 200,
      message: 'Retrieved grid-trade-archive-by-quote-asset',
      data: {
        rows,
        stats
      }
    });
  });
};

module.exports = { handleGridTradeArchiveGetByQuoteAsset };
