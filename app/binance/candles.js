const { v4: uuidv4 } = require('uuid');
const _ = require('lodash');
const queue = require('../cronjob/trailingTradeHelper/queue');
const { executeTrailingTrade } = require('../cronjob/index');
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
      const getCandles = async () => {
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

        const candles = await binance.client.candles({
          symbol,
          interval,
          limit
        });

        const operations = candles.map(candle => ({
          updateOne: {
            filter: {
              key: symbol,
              time: +candle.openTime,
              interval
            },
            update: {
              $set: {
                open: +candle.open,
                high: +candle.high,
                low: +candle.low,
                close: +candle.close,
                volume: +candle.volume
              }
            },
            upsert: true
          }
        }));

        await mongo.bulkWrite(logger, 'trailing-trade-candles', operations);
      };

      queue.execute(logger, symbol, {
        correlationId: uuidv4(),
        preprocessFn: getCandles,
        processFn: executeTrailingTrade
      });
    })
  );
};

const getWebsocketCandlesClean = () => websocketCandlesClean;

module.exports = {
  setupCandlesWebsocket,
  syncCandles,
  getWebsocketCandlesClean
};
