const _ = require('lodash');
const moment = require('moment');

const { cache } = require('../helpers');

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

  const common = {
    accountInfo: JSON.parse(cacheSimpleStopChaserCommon['account-info']),
    lastProcessed: JSON.parse(cacheSimpleStopChaserCommon['last-processed']),
    configuration: JSON.parse(cacheSimpleStopChaserCommon.configuration)
  };

  _.forIn(cacheSimpleStopChaserSymbols, (value, key) => {
    const { symbol, newKey } = getSymbolFromKey(key);
    if (stats.symbols[symbol] === undefined) {
      stats.symbols[symbol] = {
        symbol,
        baseAsset: null,
        quoteAsset: null,
        balance: {
          free: 0,
          locked: 0,
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

      _.forEach(common.accountInfo.balances, b => {
        if (b.asset === baseAsset) {
          finalStat.balance.free = +b.free;
          finalStat.balance.locked = +b.locked;
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
      finalStat.sell.lastBuyPrice = sellSignal.lastBuyPrice;
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

    if (newKey === 'open-orders') {
      const openOrders = JSON.parse(value);
      if (openOrders[0]) {
        finalStat.openOrder.type = openOrders[0].type;
        finalStat.openOrder.side = openOrders[0].side;
        finalStat.openOrder.qty = +openOrders[0].origQty;
        finalStat.openOrder.stopPrice = +openOrders[0].stopPrice;
        finalStat.openOrder.createdAt = moment(openOrders[0].time).utc();
      }
    }

    if (newKey === 'chase-stop-loss-limit-order-open-order-result') {
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

    stats.symbols[symbol] = finalStat;
  });

  const configuration = JSON.parse(
    await cache.hget('simple-stop-chaser-common', `configuration`)
  );

  logger.info({ stats, configuration }, 'stats');

  ws.send(
    JSON.stringify({ result: true, type: 'latest', stats, configuration })
  );
};

module.exports = { handleLatest };
