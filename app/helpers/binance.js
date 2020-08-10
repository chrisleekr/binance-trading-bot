const _ = require('lodash');
const config = require('config');

const Binance = require('binance-api-node').default;
const cache = require('./cache');

const binanceOptions = {};

if (process.env.BINANCE_MODE === 'live') {
  binanceOptions.apiKey = config.get('binance.live.apiKey') || '';
  binanceOptions.apiSecret = config.get('binance.live.secretKey') || '';
} else {
  binanceOptions.httpBase = 'https://testnet.binance.vision';
  binanceOptions.apiKey = config.get('binance.test.apiKey') || '';
  binanceOptions.apiSecret = config.get('binance.test.secretKey') || '';
}

const client = Binance(binanceOptions);

const getSymbolInfo = async (logger, symbol) => {
  const cachedSymbolInfo = await cache.get('symbol-info');
  if (cachedSymbolInfo) {
    logger.info({ cachedSymbolInfo }, 'Retreived symbol info from cache');
    return JSON.parse(cachedSymbolInfo);
  }

  logger.info({}, 'Request exchange info from Binance');
  const exchangeInfo = await client.exchangeInfo();
  logger.info({}, 'Retrieved exchange info from Binance');
  const symbolInfo =
    _.filter(exchangeInfo.symbols, s => {
      return s.symbol === symbol;
    })[0] || {};

  symbolInfo.filterLotSize = _.filter(symbolInfo.filters, f => f.filterType === 'LOT_SIZE')[0] || {};
  symbolInfo.filterPrice = _.filter(symbolInfo.filters, f => f.filterType === 'PRICE_FILTER')[0] || {};
  symbolInfo.filterPercent = _.filter(symbolInfo.filters, f => f.filterType === 'PERCENT_PRICE')[0] || {};
  symbolInfo.filterMinNotional = _.filter(symbolInfo.filters, f => f.filterType === 'MIN_NOTIONAL')[0] || {};

  const success = cache.set('symbol-info', JSON.stringify(symbolInfo), 600);
  logger.info({ success, symbolInfo }, 'Retreived symbol info from Binance');
  return symbolInfo;
};

module.exports = { client, getSymbolInfo };
