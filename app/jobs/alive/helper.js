const config = require('config');
const _ = require('lodash');
const { binance } = require('../../helpers');

/**
 * Get balance from Binance
 *
 * @param {*} logger
 */
const getBalance = async logger => {
  const balanceSymbols = config.get('jobs.alive.balanceSymbols').split(',');
  const accountInfo = await binance.client.accountInfo();

  const balances = _.filter(accountInfo.balances, b => balanceSymbols.includes(b.asset));

  logger.info({ balances }, 'Retrieved balances');
  return balances;
};

/**
 * Get last candle from Binance
 *
 * @param {*} logger
 */
const getLastCandle = async logger => {
  const candle = await binance.client.candles({
    symbol: config.get('jobs.alive.priceSymbol'),
    interval: '1m',
    limit: 1
  });

  logger.info({ candle }, 'Retrieved last candle');
  return candle;
};

module.exports = { getBalance, getLastCandle };
