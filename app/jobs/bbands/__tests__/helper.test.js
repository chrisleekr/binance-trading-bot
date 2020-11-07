/* eslint-disable global-require */
const config = require('config');
const { binance, logger, slack } = require('../../../helpers');
const commonHelper = require('../../common/helper');

const bbandsHelper = require('../helper');

jest.mock('config');

describe('helper', () => {
  let result;

  describe('getIndicators', () => {
    beforeEach(async () => {
      config.get = jest.fn(key => {
        switch (key) {
          case 'jobs.bbands.symbol':
            return 'BTCUSDT';
          case 'jobs.bbands.candles.interval':
            return '1m';
          case 'jobs.bbands.candles.limit':
            return 200;
          case 'jobs.bbands.period':
            return 50;
          case 'jobs.bbands.stddev':
            return 2;
          default:
            return '';
        }
      });

      binance.client.candles = jest.fn().mockResolvedValue(require('./fixtures/binance-candles.json'));

      result = await bbandsHelper.getIndicators(logger);
    });

    it('returns expected result', () => {
      expect(result).toStrictEqual({
        bbands: {
          openTime: '2020-10-31 21:00:00',
          lower: 13691.91604847195,
          middle: 13792.602399999998,
          upper: 13893.288751528045
        },
        lastCandle: {
          openTime: 1604138400000,
          open: '13893.23000000',
          high: '13893.24000000',
          low: '13893.23000000',
          close: '13893.24000000',
          volume: '0.95549000',
          closeTime: 1604138459999,
          quoteVolume: '13274.84888760',
          trades: 3,
          baseAssetVolume: '0.65549000',
          quoteAssetVolume: '9106.87988760'
        }
      });
    });
  });

  describe('determineAction', () => {
    describe('when last candle closed price is lower than bollinger bands lower price', () => {
      beforeEach(() => {
        result = bbandsHelper.determineAction(logger, {
          lastCandle: {
            close: 13893
          },
          bbands: {
            lower: 13991,
            upper: 14493
          }
        });
      });

      it('returns expected result', () => {
        expect(result).toBe('buy');
      });
    });

    describe('when last candle closed price is more than bollinger bands upper price', () => {
      beforeEach(() => {
        result = bbandsHelper.determineAction(logger, {
          lastCandle: {
            close: 13894
          },
          bbands: {
            lower: 12991,
            upper: 13893
          }
        });
      });

      it('returns expected result', () => {
        expect(result).toBe('sell');
      });
    });

    describe('when last candle closed price is within range', () => {
      beforeEach(() => {
        result = bbandsHelper.determineAction(logger, {
          lastCandle: {
            close: 13894
          },
          bbands: {
            lower: 12991,
            upper: 13895
          }
        });
      });

      it('returns expected result', () => {
        expect(result).toBe('hold');
      });
    });
  });

  describe('placeOrder', () => {
    beforeEach(async () => {
      slack.sendMessage = jest.fn().mockResolvedValue(true);
      binance.client.order = jest.fn().mockResolvedValue({ result: true });

      config.get = jest.fn(key => {
        switch (key) {
          case 'jobs.bbands.symbol':
            return 'BTCUSDT';
          case 'jobs.bbands.candles.interval':
            return '1m';
          case 'jobs.bbands.candles.limit':
            return 200;
          case 'jobs.bbands.period':
            return 50;
          case 'jobs.bbands.stddev':
            return 2;
          default:
            return '';
        }
      });
    });

    describe('when could not get balance', () => {
      beforeEach(async () => {
        commonHelper.cancelOpenOrders = jest.fn().mockResolvedValue({ result: true });
        commonHelper.getSymbolInfo = jest.fn().mockResolvedValue(require('./fixtures/helper-get-symbol-info1.json'));
        commonHelper.getBalance = jest.fn().mockResolvedValue({
          result: false
        });

        const indicator = require('./fixtures/helper-get-indicators.json');

        result = await bbandsHelper.placeOrder(logger, 'buy', 100, indicator);
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({
          result: false
        });
      });
    });

    describe('when could not get order quantity', () => {
      beforeEach(async () => {
        commonHelper.cancelOpenOrders = jest.fn().mockResolvedValue({ result: true });
        commonHelper.getSymbolInfo = jest.fn().mockResolvedValue(require('./fixtures/helper-get-symbol-info1.json'));
        commonHelper.getBalance = jest.fn().mockResolvedValue({
          result: true,
          message: 'Balance found',
          freeBalance: 0.005
        });

        const indicator = require('./fixtures/helper-get-indicators.json');

        result = await bbandsHelper.placeOrder(logger, 'buy', 100, indicator);
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({
          baseAssetPrice: 13893.24,
          freeBalance: 0.005,
          message: 'Order quantity is less or equal than 0.',
          orderQuantity: 0,
          result: false
        });
      });
    });

    describe('when could not get order price', () => {
      beforeEach(async () => {
        commonHelper.cancelOpenOrders = jest.fn().mockResolvedValue({ result: true });
        commonHelper.getSymbolInfo = jest.fn().mockResolvedValue(require('./fixtures/helper-get-symbol-info1.json'));
        commonHelper.getBalance = jest.fn().mockResolvedValue({
          result: true,
          message: 'Balance found',
          freeBalance: 0.01
        });

        const indicator = require('./fixtures/helper-get-indicators.json');

        result = await bbandsHelper.placeOrder(logger, 'buy', 100, indicator);
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({
          message: 'Notional value is less than minimum notional value.',
          orderPrice: 13893.24,
          result: false
        });
      });
    });

    describe('when good to buy', () => {
      beforeEach(async () => {
        commonHelper.cancelOpenOrders = jest.fn().mockResolvedValue({ result: true });
        commonHelper.getSymbolInfo = jest.fn().mockResolvedValue(require('./fixtures/helper-get-symbol-info1.json'));
        commonHelper.getBalance = jest.fn().mockResolvedValue({
          result: true,
          message: 'Balance found',
          freeBalance: 80
        });

        const indicator = require('./fixtures/helper-get-indicators.json');

        result = await bbandsHelper.placeOrder(logger, 'buy', 100, indicator);
      });

      it('triggers binance.client.order', () => {
        expect(binance.client.order).toHaveBeenCalledWith({
          symbol: 'BTCUSDT',
          side: 'buy',
          type: 'LIMIT',
          quantity: 0.005752,
          price: 13893.24,
          timeInForce: 'GTC'
        });
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({
          result: true
        });
      });
    });

    describe('when good to sell', () => {
      beforeEach(async () => {
        commonHelper.cancelOpenOrders = jest.fn().mockResolvedValue({ result: true });
        commonHelper.getSymbolInfo = jest.fn().mockResolvedValue(require('./fixtures/helper-get-symbol-info1.json'));
        commonHelper.getBalance = jest.fn().mockResolvedValue({
          result: true,
          message: 'Balance found',
          freeBalance: 0.1
        });

        const indicator = require('./fixtures/helper-get-indicators.json');

        result = await bbandsHelper.placeOrder(logger, 'sell', 100, indicator);
      });

      it('triggers binance.client.order', () => {
        expect(binance.client.order).toHaveBeenCalledWith({
          symbol: 'BTCUSDT',
          side: 'sell',
          type: 'LIMIT',
          quantity: 0.0999,
          price: 13893.24,
          timeInForce: 'GTC'
        });
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({
          result: true
        });
      });
    });
  });
});
