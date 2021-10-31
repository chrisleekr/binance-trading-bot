const qs = require('qs');
const _ = require('lodash');
const axios = require('axios');
const { cache } = require('../../../helpers');

const getInterval = interval => {
  switch (interval) {
    case '3m':
      return '5m';
    default:
      return interval;
  }
};

// This variable will store last TradingView response per symbol to avoid saving the duplicated log.
const lastTradingView = {};

/**
 * Retreive trading view for symbols per interval
 *
 * @param {*} logger
 * @param {*} symbols
 * @param {*} interval
 * @returns
 */
const retrieveTradingView = async (logger, symbols, interval) => {
  const params = {
    symbols: symbols.reduce((acc, s) => {
      acc.push(`BINANCE:${s}`);
      return acc;
    }, []),
    screener: 'CRYPTO',
    interval
  };

  try {
    const response = await axios.get('http://tradingview:8080', {
      params,
      paramsSerializer:
        /* istanbul ignore next */
        p => qs.stringify(p, { arrayFormat: 'repeat' }),
      timeout: 20000 // timeout 20 seconds
    });
    const tradingViewResult = _.get(response.data, 'result', {});

    if (_.isEmpty(tradingViewResult) === true) {
      // If result is empty, do not process.
      return;
    }

    _.forIn(tradingViewResult, (result, symbolKey) => {
      // Get symbol
      const symbol = symbolKey.replace('BINANCE:', '');

      // Set saveLog as false by default
      let saveLog = false;

      const newRecommendation = _.get(result, 'summary.RECOMMENDATION', '');

      // If new recommendation is different than previous recommendation,
      if (
        _.get(lastTradingView, `${symbol}.summary.RECOMMENDATION`, '') !==
        newRecommendation
      ) {
        // Then saveLog as true
        saveLog = true;
      }

      // If recommendation is retrieved,
      if (newRecommendation !== '') {
        logger.info(
          { symbol, data: result, saveLog },
          `The TradingView technical analysis recommendation for ${symbol} is "${_.get(
            result,
            'summary.RECOMMENDATION'
          )}".`
        );

        lastTradingView[symbol] = result;
        cache.hset(
          'trailing-trade-tradingview',
          symbol,
          JSON.stringify({
            request: {
              symbol,
              screener: 'CRYPTO',
              exchange: 'BINANCE',
              interval
            },
            result
          })
        );
      } else {
        logger.info(
          { symbol, data: result, saveLog },
          `The TradingView technical analysis recommendation for ${symbol} could not be retrieved.`
        );
      }
    });
  } catch (err) {
    logger.error(
      { err, saveLog: true },
      'Error occurred while retrieving TradingView technical analysis...'
    );
  }
};

/**
 * Get Tradingview indicators
 *
 * @param {*} funcLogger
 * @param {*} rawData
 */
const execute = async (funcLogger, rawData) => {
  const data = rawData;

  const {
    globalConfiguration: { symbols }
  } = data;

  const logger = funcLogger.child({ symbols });

  logger.info('get-trading-view started');

  if (_.isEmpty(symbols)) {
    logger.info('No symbols configured. Do not process get-trading-view');
    return data;
  }

  // Should get all symbol configurations and make group call per interval
  const cachedSymbolConfigurations = await cache.hgetall(
    'trailing-trade-configurations:',
    'trailing-trade-configurations:*'
  );

  const tradingViewRequests = {};

  _.forIn(cachedSymbolConfigurations, (value, symbol) => {
    if (symbol === 'global') {
      return;
    }

    const symbolConfiguration = JSON.parse(value);

    const {
      candles: { interval },
      botOptions: {
        tradingView: { interval: tradingViewInterval }
      }
    } = symbolConfiguration;

    const finalInterval = getInterval(
      tradingViewInterval !== '' ? tradingViewInterval : interval
    );

    if (tradingViewRequests[finalInterval] === undefined) {
      tradingViewRequests[finalInterval] = {
        symbols: [],
        interval: finalInterval
      };
    }
    tradingViewRequests[finalInterval].symbols.push(symbol);
  });

  const promises = [];

  _.forIn(tradingViewRequests, async (request, _requestInterval) => {
    promises.push(
      retrieveTradingView(logger, request.symbols, request.interval)
    );
  });

  Promise.all(promises);

  return data;
};

module.exports = { execute };
