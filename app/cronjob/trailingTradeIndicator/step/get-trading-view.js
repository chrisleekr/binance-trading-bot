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

/**
 * Get Tradingview indicators
 *
 * @param {*} logger
 * @param {*} rawData
 */
const execute = async (logger, rawData) => {
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
      params
    });
    logger.info(
      { data: response.data, tag: 'tradingview' },
      'trading view indicators'
    );
    await cache.hset(
      'trailing-trade-tradingview',
      symbol,
      JSON.stringify(response.data)
    );

    data.tradingView = response.data;
  } catch (err) {
    logger.error(
      { err },
      'Error occurred while retrieving trading view indicators'
    );
  }

  return data;
};

module.exports = { execute };
