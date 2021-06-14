const _ = require('lodash');
const moment = require('moment');
const { cache, PubSub } = require('../../../helpers');
const {
  getGlobalConfiguration
} = require('../../../cronjob/trailingTradeHelper/configuration');

const handleManualTradeAllSymbols = async (logger, ws, payload) => {
  logger.info({ payload }, 'Start manual trade all symbols');

  const {
    data: {
      orders: { side, buy, sell }
    }
  } = payload;

  PubSub.publish('frontend-notification', {
    type: 'info',
    title:
      'The orders received by the bot. Start queuing the orders to place. Orders will be placed in sequence.'
  });

  // Retrieve global configuration
  const globalConfiguration = await getGlobalConfiguration(logger);

  const {
    system: { placeManualOrderInterval }
  } = globalConfiguration;

  let currentTime = moment();
  if (side === 'buy') {
    _.forOwn(buy.symbols, (quoteAsset, _quoteSymbol) => {
      _.forOwn(quoteAsset.baseAssets, (baseAsset, _baseSymbol) => {
        const { symbol } = baseAsset;
        const quoteOrderQty = parseFloat(baseAsset.quoteOrderQty);

        if (quoteOrderQty > 0) {
          const symbolOrder = {
            action: 'manual-trade',
            order: {
              side: 'buy',
              buy: {
                type: buy.type,
                marketType: buy.marketType,
                quoteOrderQty
              }
            },
            actionAt: currentTime
          };

          logger.info({ symbolOrder }, `Queueing order for ${symbol}.`);

          cache.hset(
            'trailing-trade-override',
            `${symbol}`,
            JSON.stringify(symbolOrder)
          );

          logger.info(
            { baseAsset, symbolOrder },
            `Order for ${symbol} has been queued.`
          );

          currentTime = moment(currentTime).add(
            placeManualOrderInterval,
            'seconds'
          );
        }
      });
    });
  }

  if (side === 'sell') {
    _.forOwn(sell.symbols, (quoteAsset, _quoteSymbol) => {
      _.forOwn(quoteAsset.baseAssets, (baseAsset, _baseSymbol) => {
        const { symbol } = baseAsset;
        const marketQuantity = parseFloat(baseAsset.marketQuantity);

        if (marketQuantity > 0) {
          const symbolOrder = {
            action: 'manual-trade',
            order: {
              side: 'sell',
              sell: {
                type: sell.type,
                marketType: sell.marketType,
                marketQuantity
              }
            },
            actionAt: currentTime
          };
          logger.info({ symbolOrder }, `Queueing order for ${symbol}.`);

          cache.hset(
            'trailing-trade-override',
            `${symbol}`,
            JSON.stringify(symbolOrder)
          );

          logger.info(
            { baseAsset, symbolOrder },
            `Order for ${symbol} has been queued.`
          );

          currentTime = moment(currentTime).add(
            placeManualOrderInterval,
            'seconds'
          );
        }
      });
    });
  }

  ws.send(
    JSON.stringify({
      result: true,
      type: 'manual-trade-all-symbols-result',
      message: 'The orders have been received.'
    })
  );
};

module.exports = { handleManualTradeAllSymbols };
