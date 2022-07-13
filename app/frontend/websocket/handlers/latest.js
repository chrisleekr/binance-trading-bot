const _ = require('lodash');
const { version } = require('../../../../package.json');

const { binance, cache, mongo } = require('../../../helpers');
const {
  getConfiguration
} = require('../../../cronjob/trailingTradeHelper/configuration');

const {
  isActionDisabled
} = require('../../../cronjob/trailingTradeHelper/common');

const handleLatest = async (logger, ws, payload) => {
  const globalConfiguration = await getConfiguration(logger);
  // logger.info({ globalConfiguration }, 'Configuration from MongoDB');

  const { sortByDesc, searchKeyword, page } = payload.data;

  // If not authenticated and lock list is enabled, then do not send any information.
  if (
    payload.isAuthenticated === false &&
    globalConfiguration.botOptions.authentication.lockList === true
  ) {
    ws.send(
      JSON.stringify({
        result: true,
        type: 'latest',
        isAuthenticated: payload.isAuthenticated,
        botOptions: globalConfiguration.botOptions,
        configuration: {},
        common: {},
        closedTradesSetting: {},
        closedTrades: [],
        stats: {}
      })
    );

    return;
  }

  const cacheTrailingTradeCommon = await cache.hgetall(
    'trailing-trade-common:',
    'trailing-trade-common:*'
  );

  const symbolsCount = globalConfiguration.symbols.length;
  const symbolsPerPage = 12;
  const totalPages = _.ceil(symbolsCount / symbolsPerPage);

  const match = {};

  if (searchKeyword) {
    match.symbol = {
      $regex: searchKeyword,
      $options: 'i'
    };
  }

  const sortBy = payload.data.sortBy || 'default';
  const sortDirection = sortByDesc === true ? -1 : 1;

  logger.info({ sortBy, sortDirection }, 'latest');

  let sortField = {
    $cond: {
      if: { $gt: [{ $size: '$buy.openOrders' }, 0] },
      then: {
        $multiply: [
          {
            $add: [
              {
                $let: {
                  vars: {
                    buyOpenOrder: {
                      $arrayElemAt: ['$buy.openOrders', 0]
                    }
                  },
                  in: '$buyOpenOrder.differenceToCancel'
                }
              },
              3000
            ]
          },
          -10
        ]
      },
      else: {
        $cond: {
          if: { $gt: [{ $size: '$sell.openOrders' }, 0] },
          then: {
            $multiply: [
              {
                $add: [
                  {
                    $let: {
                      vars: {
                        sellOpenOrder: {
                          $arrayElemAt: ['$sell.openOrders', 0]
                        }
                      },
                      in: '$sellOpenOrder.differenceToCancel'
                    }
                  },
                  2000
                ]
              },
              -10
            ]
          },
          else: {
            $cond: {
              if: {
                $eq: ['$sell.difference', null]
              },
              then: '$symbol',
              else: {
                $multiply: [{ $add: ['$sell.difference', 1000] }, -10]
              }
            }
          }
        }
      }
    }
  };

  if (sortBy === 'buy-difference') {
    sortField = {
      $cond: {
        if: {
          $eq: ['$buy.difference', null]
        },
        then: '$symbol',
        else: '$buy.difference'
      }
    };
  }

  if (sortBy === 'sell-profit') {
    sortField = {
      $cond: {
        if: {
          $eq: ['$sell.currentProfitPercentage', null]
        },
        then: '$symbol',
        else: '$sell.currentProfitPercentage'
      }
    };
  }

  if (sortBy === 'alpha') {
    sortField = '$symbol';
  }

  const trailingTradeCacheQuery = [
    {
      $match: match
    },
    {
      $project: {
        symbol: '$symbol',
        lastCandle: '$lastCandle',
        symbolInfo: '$symbolInfo',
        symbolConfiguration: '$symbolConfiguration',
        baseAssetBalance: '$baseAssetBalance',
        quoteAssetBalance: '$quoteAssetBalance',
        buy: '$buy',
        sell: '$sell',
        tradingView: '$tradingView',
        overrideData: '$overrideData',
        sortField
      }
    },
    { $sort: { sortField: sortDirection } },
    { $skip: (page - 1) * symbolsPerPage },
    { $limit: symbolsPerPage }
  ];

  const cacheTrailingTradeSymbols = await mongo.aggregate(
    logger,
    'trailing-trade-cache',
    trailingTradeCacheQuery
  );

  // Calculate total profit/loss
  const cacheTrailingTradeTotalProfitAndLoss = await mongo.aggregate(
    logger,
    'trailing-trade-cache',
    [
      {
        $group: {
          _id: '$quoteAssetBalance.asset',
          amount: {
            $sum: {
              $multiply: ['$baseAssetBalance.total', '$sell.lastBuyPrice']
            }
          },
          profit: { $sum: '$sell.currentProfit' },
          estimatedBalance: { $sum: '$baseAssetBalance.estimatedValue' }
        }
      },
      {
        $project: {
          asset: '$_id',
          amount: '$amount',
          profit: '$profit',
          estimatedBalance: '$estimatedBalance'
        }
      }
    ]
  );

  const cacheTrailingTradeClosedTrades = _.map(
    await cache.hgetall(
      'trailing-trade-closed-trades:',
      'trailing-trade-closed-trades:*'
    ),
    stats => JSON.parse(stats)
  );

  const streamsCount = await cache.hget('trailing-trade-streams', 'count');

  const stats = {
    symbols: {}
  };

  let common = {};
  try {
    common = {
      version,
      gitHash: process.env.GIT_HASH || 'unspecified',
      accountInfo: JSON.parse(cacheTrailingTradeCommon['account-info']),
      apiInfo: binance.client.getInfo(),
      closedTradesSetting: JSON.parse(
        cacheTrailingTradeCommon['closed-trades']
      ),
      orderStats: {
        numberOfOpenTrades: parseInt(
          cacheTrailingTradeCommon['number-of-open-trades'],
          10
        ),
        numberOfBuyOpenOrders: parseInt(
          cacheTrailingTradeCommon['number-of-buy-open-orders'],
          10
        )
      },
      closedTrades: cacheTrailingTradeClosedTrades,
      totalProfitAndLoss: cacheTrailingTradeTotalProfitAndLoss,
      streamsCount,
      symbolsCount,
      totalPages
    };
  } catch (err) {
    logger.error({ err }, 'Something wrong with trailing-trade-common cache');
    return;
  }

  stats.symbols = await Promise.all(
    _.map(cacheTrailingTradeSymbols, async symbol => {
      const newSymbol = symbol;
      newSymbol.tradingView = JSON.parse(symbol.tradingView);
      // Retrieve action disabled
      newSymbol.isActionDisabled = await isActionDisabled(newSymbol.symbol);
      return newSymbol;
    })
  );

  logger.info(
    {
      account: common.accountInfo,
      publicURL: common.publicURL,
      stats,
      configuration: globalConfiguration
    },
    'stats'
  );

  ws.send(
    JSON.stringify({
      result: true,
      type: 'latest',
      isAuthenticated: payload.isAuthenticated,
      botOptions: globalConfiguration.botOptions,
      configuration: globalConfiguration,
      common,
      stats
    })
  );
};

module.exports = { handleLatest };
