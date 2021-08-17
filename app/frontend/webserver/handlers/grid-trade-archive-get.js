const moment = require('moment-timezone');
const {
  verifyAuthenticated
} = require('../../../cronjob/trailingTradeHelper/common');

const { mongo } = require('../../../helpers');

const handleGridTradeArchiveGet = async (funcLogger, app) => {
  const logger = funcLogger.child({
    endpoint: '/grid-trade-archive-get'
  });

  app.route('/grid-trade-archive-get').post(async (req, res) => {
    const {
      authToken,
      type,
      symbol,
      quoteAsset,
      page: rawPage,
      limit: rawLimit,
      start,
      end
    } = req.body;

    // Verify authentication

    const page = rawPage || 1;
    const limit = rawLimit || 5;

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

    if (['symbol', 'quoteAsset'].includes(type) === false) {
      return res.send({
        success: false,
        status: 400,
        message: `${type} is not allowed`,
        data: {
          rows: [],
          stats: {}
        }
      });
    }

    const match = {};
    const group = {};
    const project = {};
    const initialValue = {};

    if (start || end) {
      match.archivedAt = {
        ...(start ? { $gte: moment(start).toISOString() } : {}),
        ...(end ? { $lte: moment(end).toISOString() } : {})
      };
    }

    // eslint-disable-next-line default-case
    switch (type) {
      case 'symbol':
        match.symbol = symbol;
        // eslint-disable-next-line no-underscore-dangle
        group._id = '$symbol';
        group.symbol = { $first: '$symbol' };
        project.symbol = 1;
        initialValue.symbol = symbol;
        break;
      case 'quoteAsset':
        match.quoteAsset = quoteAsset;
        // eslint-disable-next-line no-underscore-dangle
        group._id = '$quoteAsset';
        group.quoteAsset = { $first: '$quoteAsset' };
        project.quoteAsset = 1;
        initialValue.quoteAsset = quoteAsset;
        break;
    }

    const rows = await mongo.findAll(
      logger,
      'trailing-trade-grid-trade-archive',
      match,
      {
        sort: { archivedAt: -1 },
        skip: (page - 1) * limit,
        limit
      }
    );

    const stats = (
      await mongo.aggregate(logger, 'trailing-trade-grid-trade-archive', [
        {
          $match: match
        },
        {
          $group: {
            ...group,
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
            ...project,
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
            trades: 1
          }
        }
      ])
    )[0] || {
      ...initialValue,
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
      message: 'Retrieved grid-trade-archive-get',
      data: {
        rows,
        stats
      }
    });
  });
};

module.exports = { handleGridTradeArchiveGet };
