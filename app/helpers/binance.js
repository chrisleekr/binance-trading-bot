const config = require('config');

const Binance = require('binance-api-node').default;

const binanceOptions = {};

if (config.get('mode') === 'live') {
  binanceOptions.apiKey = config.get('binance.live.apiKey');
  binanceOptions.apiSecret = config.get('binance.live.secretKey');
} else {
  binanceOptions.httpBase = 'https://testnet.binance.vision';
  binanceOptions.apiKey = config.get('binance.test.apiKey');
  binanceOptions.apiSecret = config.get('binance.test.secretKey');
}

const client = Binance(binanceOptions);

module.exports = { client };
