/* istanbul ignore file */
const qs = require('qs');
const _ = require('lodash');
const config = require('config');
const axios = require('axios');
const { logger } = require('../helpers');

(async () => {
  const tradingviewUrl = `http://${config.get('tradingview.host')}:${config.get(
    'tradingview.port'
  )}`;

  const symbols = ['BTCUSDT', 'BNBUSDT'];

  const params = {
    symbols: symbols.reduce((acc, s) => {
      acc.push(`BINANCE:${s}`);
      return acc;
    }, []),
    screener: 'CRYPTO',
    interval: '30m'
  };

  const response = await axios.get(tradingviewUrl, {
    params,
    paramsSerializer:
      /* istanbul ignore next */
      p => qs.stringify(p, { arrayFormat: 'repeat' }),
    timeout: 20000 // timeout 20 seconds
  });
  const tradingViewResult = _.get(response.data, 'result', {});

  logger.info({ tradingViewResult }, 'TradingView result');
  process.exit(0);
})();
