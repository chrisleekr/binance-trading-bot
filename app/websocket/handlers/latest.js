const _ = require('lodash');
const moment = require('moment');

const { cache, mongo } = require('../../helpers');

const getSymbolFromKey = key => {
  const fragments = key.split('-');
  const symbol = fragments[0];
  fragments.shift();
  return {
    symbol,
    newKey: fragments.join('-')
  };
};

const handleLatest = async (logger, ws, _payload) => {
  const cacheSimpleStopChaserCommon = await cache.hgetall(
    'simple-stop-chaser-common'
  );
  const cacheSimpleStopChaserSymbols = await cache.hgetall(
    'simple-stop-chaser-symbols'
  );
  logger.info(
    { cacheSimpleStopChaserCommon, cacheSimpleStopChaserSymbols },
    'cached values'
  );

  const stats = {
    symbols: {}
  };

  const configuration = await mongo.findOne(
    logger,
    'simple-stop-chaser-common',
    {
      key: 'configuration'
    }
  );
  logger.info({ configuration }, 'Configuration from MongoDB');

  let common = {};
  try {
    common = {
      configuration,
      accountInfo: JSON.parse(cacheSimpleStopChaserCommon['account-info']),
      lastProcessed: JSON.parse(cacheSimpleStopChaserCommon['last-processed']),
      exchangeSymbols: JSON.parse(
        cacheSimpleStopChaserCommon['exchange-symbols']
      ),
      publicURL: cacheSimpleStopChaserCommon['local-tunnel-url']
    };
  } catch (e) {
    logger.error({ e }, 'Something wrong with simple-stop-chaser-common cache');

    return;
  }

  _.forIn(cacheSimpleStopChaserSymbols, (value, key) => {
    const { symbol, newKey } = getSymbolFromKey(key);
    if (stats.symbols[symbol] === undefined) {
      stats.symbols[symbol] = {
        symbol,
        baseAsset: null,
        quoteAsset: null,
        precision: 4,
        balance: {
          total: 0,
          free: 0,
          locked: 0,
          estimatedValue: 0,
          updatedAt: null
        },
        buy: {
          action: null,
          currentPrice: null,
          lowestPrice: null,
          difference: null,
          updatedAt: null
        },
        sell: {
          lastBuyPrice: null,
          minimumSellingPrice: null,
          currentPrice: null,
          difference: null,
          currentProfit: null,
          currentProfitPercentage: null,
          processMessage: null,
          updatedAt: null
        },
        openOrder: {
          type: null,
          side: null,
          qty: null,
          stopPrice: null,
          createdAt: null,
          processMessage: null,
          currentPrice: null,
          limitPercentage: null,
          limitPrice: null,
          difference: null,
          lastBuyPrice: null,
          minimumProfit: null,
          minimumProfitPercentage: null,
          updatedAt: null
        }
      };
    }

    const finalStat = stats.symbols[symbol];

    if (newKey === 'symbol-info') {
      const symbolInfo = JSON.parse(value);
      const { baseAsset, quoteAsset } = symbolInfo;
      finalStat.baseAsset = baseAsset;
      finalStat.quoteAsset = quoteAsset;

      finalStat.precision = symbolInfo.filterPrice.tickSize.indexOf(1) - 1;

      _.forEach(common.accountInfo.balances, b => {
        if (b.asset === baseAsset) {
          finalStat.balance.free = +b.free;
          finalStat.balance.locked = +b.locked;
          finalStat.balance.total = +b.free + +b.locked;
          finalStat.balance.updatedAt = moment(
            common.accountInfo.updateTime
          ).utc();
        }
      });
    }

    if (newKey === 'determine-action') {
      const determineAction = JSON.parse(value);
      finalStat.buy.action = determineAction.action;
      finalStat.buy.currentPrice = determineAction.lastCandleClose;
      finalStat.buy.lowestPrice = determineAction.lowestClosed;
      finalStat.buy.difference =
        (1 - determineAction.lastCandleClose / determineAction.lowestClosed) *
        -100;
      finalStat.buy.updatedAt = determineAction.timeUTC;
    }

    if (newKey === 'chase-stop-loss-limit-order-sell-signal') {
      const sellSignal = JSON.parse(value);
      finalStat.sell.minimumSellingPrice = sellSignal.calculatedLastBuyPrice;
      finalStat.sell.currentPrice = sellSignal.lastCandleClose;
      finalStat.sell.difference =
        (1 - sellSignal.calculatedLastBuyPrice / sellSignal.lastCandleClose) *
        100;
      finalStat.sell.updatedAt = sellSignal.timeUTC;
    }

    if (newKey === 'chase-stop-loss-limit-order-sell-signal-result') {
      const sellSignalResult = JSON.parse(value);
      finalStat.sell.processMessage = sellSignalResult.message;
    }
    let openOrders;
    if (newKey === 'open-orders') {
      openOrders = JSON.parse(value);
      if (openOrders[0]) {
        finalStat.openOrder.type = openOrders[0].type;
        finalStat.openOrder.side = openOrders[0].side;
        finalStat.openOrder.qty = +openOrders[0].origQty;
        finalStat.openOrder.stopPrice = +openOrders[0].stopPrice;
        finalStat.openOrder.createdAt = moment(openOrders[0].time).utc();
      }
    }

    if (newKey === 'chase-stop-loss-limit-order-open-order-result') {
      // Make sure open order exist, otherwise, meaningless information
      openOrders = JSON.parse(
        cacheSimpleStopChaserSymbols[`${symbol}-open-orders`]
      );

      if (openOrders[0]) {
        const openOrderResult = JSON.parse(value);
        finalStat.openOrder.processMessage = openOrderResult.message;
        finalStat.openOrder.currentPrice = +openOrderResult.lastCandleClose;
        finalStat.openOrder.stopPrice = +openOrderResult.stopPrice;
        finalStat.openOrder.limitPercentage = +openOrderResult.limitPercentage;
        finalStat.openOrder.limitPrice = +openOrderResult.limitPrice;

        finalStat.openOrder.difference =
          (1 - finalStat.openOrder.stopPrice / finalStat.openOrder.limitPrice) *
          100;

        finalStat.openOrder.updatedAt = openOrderResult.timeUTC;
      }
    }

    stats.symbols[symbol] = finalStat;
  });

  stats.symbols = await Promise.all(
    _.map(stats.symbols, async symbol => {
      const newSymbol = symbol;

      newSymbol.balance.estimatedValue =
        symbol.buy.currentPrice * symbol.balance.total;

      const lastBuyPriceDoc = await mongo.findOne(
        logger,
        'simple-stop-chaser-symbols',
        {
          key: `${newSymbol.symbol}-last-buy-price`
        }
      );
      const cachedLastBuyPrice =
        lastBuyPriceDoc && lastBuyPriceDoc.lastBuyPrice
          ? lastBuyPriceDoc.lastBuyPrice
          : null;

      newSymbol.sell.lastBuyPrice = cachedLastBuyPrice;
      newSymbol.openOrder.lastBuyPrice = cachedLastBuyPrice;

      if (symbol.openOrder.lastBuyPrice > 0 && symbol.openOrder.stopPrice > 0) {
        newSymbol.openOrder.minimumProfit =
          (symbol.openOrder.stopPrice - symbol.openOrder.lastBuyPrice) *
          symbol.openOrder.qty;
        newSymbol.openOrder.minimumProfitPercentage =
          (1 - symbol.openOrder.lastBuyPrice / symbol.openOrder.stopPrice) *
          100;
      }

      if (symbol.sell.lastBuyPrice > 0 && symbol.sell.currentPrice > 0) {
        newSymbol.sell.currentProfit =
          (symbol.sell.currentPrice - symbol.sell.lastBuyPrice) *
          symbol.balance.total;

        newSymbol.sell.currentProfitPercentage =
          (1 - symbol.sell.lastBuyPrice / symbol.sell.currentPrice) * 100;
      }
      return symbol;
    })
  );

  logger.info(
    {
      account: common.accountInfo,
      publicURL: common.publicURL,
      stats,
      configuration
    },
    'stats'
  );

  ws.send(
    JSON.stringify({
      result: true,
      type: 'latest',
      configuration,
      common,
      stats
    })
  );
};

module.exports = { handleLatest };
