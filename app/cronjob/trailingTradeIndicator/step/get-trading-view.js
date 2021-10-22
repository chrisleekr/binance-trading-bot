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
    symbol,
    symbolConfiguration: {
      candles: { interval },
      botOptions: {
        tradingView: { interval: tradingViewInterval }
      }
    }
  } = data;

  const logger = funcLogger.child({ symbol });

  const params = {
    symbol,
    screener: 'CRYPTO',
    exchange: 'BINANCE',
    interval: getInterval(
      tradingViewInterval !== '' ? tradingViewInterval : interval
    )
  };

  try {
    const response = await axios.get('http://tradingview:8080', {
      params,
      timeout: 5000 // timeout 5 seconds
    });

    let saveLog = false;
    if (
      _.get(lastTradingView, `${symbol}.result.summary.RECOMMENDATION`, '') !==
      _.get(response.data, 'result.summary.RECOMMENDATION', '')
    ) {
      saveLog = true;
    }

    logger.info(
      { data: response.data, saveLog },
      `The TradingView technical analysis recommendation is "${_.get(
        response.data,
        'result.summary.RECOMMENDATION'
      )}".`
    );

    lastTradingView[symbol] = response.data;
    await cache.hset(
      'trailing-trade-tradingview',
      symbol,
      JSON.stringify(response.data)
    );

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
