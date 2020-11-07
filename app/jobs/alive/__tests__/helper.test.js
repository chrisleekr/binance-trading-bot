/* eslint-disable global-require */
const config = require('config');
const { binance, logger } = require('../../../helpers');

const aliveHelper = require('../helper');

jest.mock('config');

describe('helper', () => {
  let result;

  describe('getBalance', () => {
    beforeEach(async () => {
      config.get = jest.fn(key => {
        if (key === 'jobs.alive.balanceSymbols') {
          return 'BTC,USDT';
        }
        return '';
      });

      binance.client.accountInfo = jest.fn().mockResolvedValue(require('./fixtures/binance-account-info.json'));

      result = await aliveHelper.getBalance(logger);
    });

    it('return expected result', () => {
      expect(result).toStrictEqual([
        { asset: 'BTC', free: '0.00000100', locked: '0.00099900' },
        { asset: 'USDT', free: '26643.34000000', locked: '0.00000000' }
      ]);
    });
  });

  describe('getLastCandle', () => {
    beforeEach(async () => {
      config.get = jest.fn(key => {
        if (key === 'jobs.alive.priceSymbol') {
          return 'BTCUSDT';
        }
        return '';
      });

      binance.client.candles = jest.fn().mockResolvedValue(require('./fixtures/binance-candles.json'));

      result = await aliveHelper.getLastCandle(logger);
    });

    it('returns expected result', () => {
      expect(result).toStrictEqual([
        {
          openTime: 1604135580000,
          open: '40000.00000000',
          high: '40000.00000000',
          low: '40000.00000000',
          close: '40000.00000000',
          volume: '0.00000000',
          closeTime: 1604135639999,
          quoteVolume: '0.00000000',
          trades: 0,
          baseAssetVolume: '0.00000000',
          quoteAssetVolume: '0.00000000'
        }
      ]);
    });
  });
});
