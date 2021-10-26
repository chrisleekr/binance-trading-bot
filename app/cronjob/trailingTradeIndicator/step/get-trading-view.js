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
 * Get Tradingview indicators
 *
 * @param {*} funcLogger
 * @param {*} rawData
 */
const execute = async (funcLogger, rawData) => {
  const data = rawData;

  const {
    globalConfiguration: { symbols },
    symbolConfiguration: {
      candles: { interval },
      botOptions: {
        tradingView: { interval: tradingViewInterval }
      }
    }
  } = data;

  const logger = funcLogger.child({ symbols });

  const finalInterval = getInterval(
    tradingViewInterval !== '' ? tradingViewInterval : interval
  );
  const params = {
    symbols: symbols.reduce((acc, s) => {
      acc.push(`BINANCE:${s}`);
      return acc;
    }, []),
    screener: 'CRYPTO',
    interval: finalInterval
  };

  try {
    const response = await axios.get('http://tradingview:8080', {
      params,
      paramsSerializer:
        /* istanbul ignore next */
        p => qs.stringify(p, { arrayFormat: 'repeat' }),
      timeout: 5000 // timeout 5 seconds
    });

    const tradingViewResult = _.get(response.data, 'result', {});
    if (_.isEmpty(tradingViewResult) === true) {
      // If result is empty, do not process.
      return data;
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
          { data: result, saveLog },
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
              interval: finalInterval
            },
            result
          })
        );
      } else {
        logger.info(
          { data: result, saveLog },
          `The TradingView technical analysis recommendation for ${symbol} could not be retrieved.`
        );
      }
    });

    data.tradingView = response.data;
  } catch (err) {
    logger.error(
      { err, saveLog: true },
      'Error occurred while retrieving TradingView technical analysis...'
    );
  }

  return data;
};

module.exports = { execute };
