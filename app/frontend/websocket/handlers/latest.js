const _ = require('lodash');
const { version } = require('../../../../package.json');

const { binance, cache } = require('../../../helpers');
const {
  getConfiguration
} = require('../../../cronjob/trailingTradeHelper/configuration');

const {
  isActionDisabled,
  countCacheTrailingTradeSymbols,
  getCacheTrailingTradeSymbols,
  getCacheTrailingTradeTotalProfitAndLoss,
  getCacheTrailingTradeQuoteEstimates
} = require('../../../cronjob/trailingTradeHelper/common');

const handleLatest = async (logger, ws, payload) => {
  const globalConfiguration = await getConfiguration(logger);

  const { sortByDesc, sortBy, searchKeyword, page } = payload.data;

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
  const cacheTradingView = await cache.hgetall(
    'trailing-trade-tradingview:',
    'trailing-trade-tradingview:*'
  );

  const symbolsPerPage = 12;

  const monitoringSymbolsCount = globalConfiguration.symbols.length;

  const cachedMonitoringSymbolsCount = await countCacheTrailingTradeSymbols(
    logger
  );

  const totalPages = _.ceil(cachedMonitoringSymbolsCount / symbolsPerPage);

  const cacheTrailingTradeSymbols = await getCacheTrailingTradeSymbols(
    logger,
    sortByDesc,
    sortBy,
    page,
    symbolsPerPage,
    searchKeyword
  );

  // Calculate total profit/loss
  const cacheTrailingTradeTotalProfitAndLoss =
    await getCacheTrailingTradeTotalProfitAndLoss(logger);

  const cacheTrailingTradeClosedTrades = _.map(
    await cache.hgetall(
      'trailing-trade-closed-trades:',
      'trailing-trade-closed-trades:*'
    ),
    stats => JSON.parse(stats)
  );

  const streamsCount = await cache.hgetWithoutLock(
    'trailing-trade-streams',
    'count'
  );

  const stats = {
    symbols: await Promise.all(
      _.map(cacheTrailingTradeSymbols, async symbol => {
        const newSymbol = { ...symbol };
        try {
          newSymbol.tradingView = JSON.parse(
            cacheTradingView[newSymbol.symbol]
          );
        } catch (e) {
          _.unset(newSymbol, 'tradingView');
        }

        // Retrieve action disabled
        newSymbol.isActionDisabled = await isActionDisabled(newSymbol.symbol);
        return newSymbol;
      })
    )
  };

  const cacheTrailingTradeQuoteEstimates =
    await getCacheTrailingTradeQuoteEstimates(logger);
  const quoteEstimatesGroupedByBaseAsset = _.groupBy(
    cacheTrailingTradeQuoteEstimates,
    'baseAsset'
  );

  let common = {};
  const accountInfo = JSON.parse(
    cacheTrailingTradeCommon['account-info'] || '{}'
  );
  accountInfo.balances = (accountInfo.balances || []).map(balance => {
    const quoteEstimate = {
      quote: null,
      estimate: null,
      tickSize: null
    };

    if (quoteEstimatesGroupedByBaseAsset[balance.asset]) {
      quoteEstimate.quote =
        quoteEstimatesGroupedByBaseAsset[balance.asset][0].quoteAsset;
      quoteEstimate.estimate =
        quoteEstimatesGroupedByBaseAsset[balance.asset][0].estimatedValue;
      quoteEstimate.tickSize =
        quoteEstimatesGroupedByBaseAsset[balance.asset][0].tickSize;
    }

    return {
      ...balance,
      ...quoteEstimate
    };
  });

  common = {
    version,
    gitHash: process.env.GIT_HASH || 'unspecified',
    accountInfo,
    apiInfo: binance.client.getInfo(),
    closedTradesSetting: JSON.parse(
      cacheTrailingTradeCommon['closed-trades'] || '{}'
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
    monitoringSymbolsCount,
    cachedMonitoringSymbolsCount,
    totalPages
  };

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
