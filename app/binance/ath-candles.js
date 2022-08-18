const _ = require('lodash');
const { binance, mongo } = require('../helpers');
const {
  getConfiguration
} = require('../cronjob/trailingTradeHelper/configuration');
const { saveCandle } = require('../cronjob/trailingTradeHelper/common');

let websocketATHCandlesClean = {};

const setupATHCandlesWebsocket = async (logger, symbols) => {
  // we have to reset the opened connections in any way since we are grouping the symbols by intervals
  // and not by their names
  if (_.isEmpty(websocketATHCandlesClean) === false) {
    logger.info('Existing opened socket for candles found, clean first');
    _.forEach(websocketATHCandlesClean, (clean, _key) => {
      clean();
    });
    websocketATHCandlesClean = {};
  }

  const athSymbolsGroupedByIntervals = {};

  // the symbols grouped by intervals to decrease the number of opened streams
  // eslint-disable-next-line no-restricted-syntax
  for (const symbol of symbols) {
    // eslint-disable-next-line no-await-in-loop
    const symbolConfiguration = await getConfiguration(logger, symbol);

    const {
      buy: {
        athRestriction: {
          enabled: buyATHRestrictionEnabled,
          candles: { interval: buyATHRestrictionCandlesInterval }
        }
      }
    } = symbolConfiguration;

    if (buyATHRestrictionEnabled === false) {
      return;
    }

    if (!athSymbolsGroupedByIntervals[buyATHRestrictionCandlesInterval]) {
      athSymbolsGroupedByIntervals[buyATHRestrictionCandlesInterval] = [];
    }

    athSymbolsGroupedByIntervals[buyATHRestrictionCandlesInterval].push(symbol);
  }

  _.forEach(
    athSymbolsGroupedByIntervals,
    async (symbolsGroup, candleInterval) => {
      websocketATHCandlesClean[candleInterval] = binance.client.ws.candles(
        symbolsGroup,
        candleInterval,
        candle => {
          saveCandle(logger, 'trailing-trade-ath-candles', {
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
    }
  );
};

/**
 * Retrieve ATH candles for symbols from Binance API
 *
 * @param {*} logger
 * @param {string[]} symbols
 */
const syncATHCandles = async (logger, symbols) => {
  await Promise.all(
    symbols.map(async symbol => {
      await mongo.deleteAll(logger, 'trailing-trade-ath-candles', {
        key: symbol
      });
      const symbolConfiguration = await getConfiguration(logger, symbol);

      const {
        buy: {
          athRestriction: {
            enabled: buyATHRestrictionEnabled,
            candles: {
              interval: buyATHRestrictionCandlesInterval,
              limit: buyATHRestrictionCandlesLimit
            }
          }
        }
      } = symbolConfiguration;

      const getCandles = async () => {
        if (buyATHRestrictionEnabled) {
          // Retrieve ath candles
          logger.info(
            {
              debug: true,
              function: 'candles',
              interval: buyATHRestrictionCandlesInterval,
              limit: buyATHRestrictionCandlesLimit
            },
            `Retrieving ATH candles from API for ${symbol}`
          );

          const athCandles = await binance.client.candles({
            symbol,
            interval: buyATHRestrictionCandlesInterval,
            limit: buyATHRestrictionCandlesLimit
          });

          const operations = athCandles.map(athCandle => ({
            updateOne: {
              filter: {
                key: symbol,
                time: +athCandle.openTime,
                interval: buyATHRestrictionCandlesInterval
              },
              update: {
                $set: {
                  open: +athCandle.open,
                  high: +athCandle.high,
                  low: +athCandle.low,
                  close: +athCandle.close,
                  volume: +athCandle.volume
                }
              },
              upsert: true
            }
          }));

          // Save ath candles for the symbol
          await mongo.bulkWrite(
            logger,
            'trailing-trade-ath-candles',
            operations
          );
        }
      };

      return getCandles();
    })
  );
};

const getWebsocketATHCandlesClean = () => websocketATHCandlesClean;

module.exports = {
  setupATHCandlesWebsocket,
  syncATHCandles,
  getWebsocketATHCandlesClean
};
