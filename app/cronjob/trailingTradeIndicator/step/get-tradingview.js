const qs = require('qs');
const _ = require('lodash');
const axios = require('axios');
const config = require('config');
const { cache } = require('../../../helpers');
const { handleError } = require('../../../error-handler');

// This variable will store last TradingView response per symbol to avoid saving the duplicated log.
const lastTradingView = {};

/**
 * Retrieve trading view for symbols per interval
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
    const tradingviewUrl = `http://${config.get(
      'tradingview.host'
    )}:${config.get('tradingview.port')}`;

    const response = await axios.get(tradingviewUrl, {
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
        _.get(
          lastTradingView,
          `${symbol}:${interval}.summary.RECOMMENDATION`,
          ''
        ) !== newRecommendation
      ) {
        // Then saveLog as true
        saveLog = true;
      }

      // If recommendation is retrieved,
      if (newRecommendation !== '') {
        logger.info(
          { symbol, interval, data: result, saveLog },
          `The TradingView technical analysis recommendation for ${symbol}:${interval} is "${_.get(
            result,
            'summary.RECOMMENDATION'
          )}".`
        );

        lastTradingView[`${symbol}:${interval}`] = result;

        cache
          .hset(
            'trailing-trade-tradingview',
            `${symbol}:${interval}`,
            JSON.stringify({
              request: {
                symbol,
                screener: 'CRYPTO',
                exchange: 'BINANCE',
                interval
              },
              result
            })
          )
          .catch(err =>
            handleError(logger, `Cache Trading View - ${symbol}`, err)
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

  logger.info('get-tradingview started');

  if (_.isEmpty(symbols)) {
    logger.info('No symbols configured. Do not process get-tradingview');
    return data;
  }

  // Should get all symbol configurations and make group call per interval
  const cachedSymbolConfigurations = await cache.hgetall(
    'trailing-trade-configurations:',
    'trailing-trade-configurations:*'
  );

  const cacheTradingViews = _.map(
    await cache.hgetall(
      'trailing-trade-tradingview:',
      'trailing-trade-tradingview:*'
    ),
    tradingView => JSON.parse(tradingView)
  );

  const tradingViewRequests = {};

  // eslint-disable-next-line no-restricted-syntax
  for (const symbol of Object.keys(cachedSymbolConfigurations)) {
    // Do not handle if it's a global configuration
    if (symbol === 'global') {
      // eslint-disable-next-line no-continue
      continue;
    }

    const symbolConfiguration = JSON.parse(cachedSymbolConfigurations[symbol]);

    const tradingViews = _.get(
      symbolConfiguration,
      'botOptions.tradingViews',
      []
    );

    const tradingViewIntervals = [];
    tradingViews.forEach(tradingView => {
      const { interval } = tradingView;

      tradingViewIntervals.push(interval);
      if (tradingViewRequests[interval] === undefined) {
        tradingViewRequests[interval] = {
          symbols: [],
          interval
        };
      }
      tradingViewRequests[interval].symbols.push(symbol);
    });

    // Delete if tradingView interval is removed from symbol configuration
    cacheTradingViews
      .filter(tv => tv.request.symbol === symbol)
      .filter(
        tv => tradingViewIntervals.includes(tv.request.interval) === false
      )
      .forEach(tv =>
        cache.hdel(
          'trailing-trade-tradingview',
          `${tv.request.symbol}:${tv.request.interval}`
        )
      );
  }

  logger.info({ tradingViewRequests }, 'Requesting TradingView intervals');
  const promises = [];

  _.forIn(tradingViewRequests, async (request, _requestInterval) => {
    promises.push(
      retrieveTradingView(logger, _.uniq(request.symbols), request.interval)
    );
  });

  await Promise.all(promises);
  logger.info('get-tradingview completed');
  return data;
};

module.exports = { execute };
