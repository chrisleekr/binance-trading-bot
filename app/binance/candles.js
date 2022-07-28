const _ = require('lodash');
const { binance, mongo } = require('../helpers');
const {
  getConfiguration
} = require('../cronjob/trailingTradeHelper/configuration');
const { saveCandle } = require('../cronjob/trailingTradeHelper/common');

let websocketCandlesClean = {};

const setupCandlesWebsocket = async (logger, symbols) => {
  // we have to reset the opened connections in any way since we are grouping the symbols by intervals
  // and not by their names
  if (_.isEmpty(websocketCandlesClean) === false) {
    logger.info('Existing opened socket for candles found, clean first');
    _.forEach(websocketCandlesClean, (clean, _key) => {
      clean();
    });
    websocketCandlesClean = {};
  }

  const symbolsGroupedByIntervals = {};

  // the symbols grouped by intervals to decrease the number of opened streams
  // eslint-disable-next-line no-restricted-syntax
  for (const symbol of symbols) {
    // eslint-disable-next-line no-await-in-loop
    const symbolConfiguration = await getConfiguration(logger, symbol);

    const {
      candles: { interval }
    } = symbolConfiguration;

    if (!symbolsGroupedByIntervals[interval]) {
      symbolsGroupedByIntervals[interval] = [];
    }

    symbolsGroupedByIntervals[interval].push(symbol);
  }

  _.forEach(symbolsGroupedByIntervals, (symbolsGroup, candleInterval) => {
    websocketCandlesClean[candleInterval] = binance.client.ws.candles(
      symbolsGroup,
      candleInterval,
      candle => {
        saveCandle(logger, 'trailing-trade-candles', {
          key: candle.symbol,
          interval: candle.interval,
          time: +candle.startTime,
          open: +candle.open,
          high: +candle.high,
          low: +candle.low,
          close: +candle.close,
          volume: +candle.volume
        });
      }
    );
  });
};

/**
 * Retrieve candles for symbols from Binance API
 *
 * @param {*} logger
 * @param {string[]} symbols
 */
const syncCandles = async (logger, symbols) => {
  await Promise.all(
    symbols.map(async symbol => {
      await mongo.deleteAll(logger, 'trailing-trade-candles', {
        key: symbol
      });

      const symbolConfiguration = await getConfiguration(logger, symbol);

      const {
        candles: { interval, limit }
      } = symbolConfiguration;

      // Retrieve candles
      logger.info(
        { debug: true, function: 'candles', interval, limit },
        `Retrieving candles from API for ${symbol}`
      );

      const getCandles = async () => {
        const candles = await binance.client.candles({
          symbol,
          interval,
          limit
        });
        await Promise.all(
          candles.map(async candle =>
            saveCandle(logger, 'trailing-trade-candles', {
              key: symbol,
              interval,
              time: +candle.openTime,
              open: +candle.open,
              high: +candle.high,
              low: +candle.low,
              close: +candle.close,
              volume: +candle.volume
            })
          )
        );
      };

      return getCandles();
    })
  );
};

const getWebsocketCandlesClean = () => websocketCandlesClean;

module.exports = {
  setupCandlesWebsocket,
  syncCandles,
  getWebsocketCandlesClean
};
