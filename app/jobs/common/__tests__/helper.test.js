/* eslint-disable global-require */
const _ = require('lodash');
const { binance, logger, cache, slack } = require('../../../helpers');

const commonHelper = require('../helper');

describe('commonHelper', () => {
  let result;

  describe('cancelOpenOrders', () => {
    describe('success', () => {
      beforeEach(async () => {
        binance.client.cancelOpenOrders = jest.fn().mockResolvedValue(true);
        await commonHelper.cancelOpenOrders(logger, binance, 'BTCUSDT');
      });

      it('triggers logger.info', () => {
        expect(logger.info).toHaveBeenCalledWith({ result: true }, 'Cancelled open orders');
      });
    });

    describe('error', () => {
      const e = new Error('something happened');
      beforeEach(async () => {
        binance.client.cancelOpenOrders = jest.fn().mockRejectedValue(e);

        await commonHelper.cancelOpenOrders(logger, binance, 'BTCUSDT');
      });

      it('triggers logger.info', () => {
        expect(logger.info).toHaveBeenCalledWith({ e }, 'Cancel result failed, but it is ok. Do not worry');
      });
    });
  });

  describe('getSymbolInfo', () => {
    describe('when there is cached symbol info', () => {
      beforeEach(async () => {
        cache.get = jest.fn().mockResolvedValue(JSON.stringify({ some: 'value' }));
        result = await commonHelper.getSymbolInfo(logger, binance, 'BTCUSDT');
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({ some: 'value' });
      });
    });

    describe('when there is no cached symbol info', () => {
      beforeEach(() => {
        cache.get = jest.fn().mockResolvedValue(false);
        cache.set = jest.fn().mockResolvedValue(true);
      });

      describe('when found symbol', () => {
        beforeEach(async () => {
          binance.client.exchangeInfo = jest.fn().mockResolvedValue(require('./fixtures/binance-exchange-info.json'));

          result = await commonHelper.getSymbolInfo(logger, binance, 'BTCUSDT');
        });

        it('returns expected value', () => {
          expect(result).toStrictEqual(require('./fixtures/helper-get-symbol-info1.json'));
        });
      });

      describe('when does not find symbol', () => {
        beforeEach(async () => {
          binance.client.exchangeInfo = jest.fn().mockResolvedValue(require('./fixtures/binance-exchange-info.json'));

          result = await commonHelper.getSymbolInfo(logger, binance, 'BTCUNKNW');
        });

        it('returns expected value', () => {
          expect(result).toStrictEqual(require('./fixtures/helper-get-symbol-info2.json'));
        });
      });
    });
  });

  describe('getBalance', () => {
    describe('when cannot find balance', () => {
      beforeEach(async () => {
        binance.client.accountInfo = jest.fn().mockResolvedValue(require('./fixtures/binance-account-info.json'));

        const symbolInfo = require('./fixtures/helper-get-symbol-info1.json');
        symbolInfo.quoteAsset = 'UNKNWN';

        result = await commonHelper.getBalance(logger, binance, symbolInfo, 'buy');
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual({
          result: false,
          message: 'Balance cannot be found.',
          balance: {}
        });
      });
    });

    describe('when tradeAction is buy and notional is less than available balance', () => {
      beforeEach(async () => {
        const symbolInfo = require('./fixtures/helper-get-symbol-info1.json');
        symbolInfo.quoteAsset = 'USDT';

        const accountInfo = require('./fixtures/binance-account-info.json');
        accountInfo.balances = _.map(accountInfo.balances, b => {
          const balance = b;
          if (balance.asset === 'USDT') {
            balance.free = '9.00000';
          }
          return balance;
        });

        binance.client.accountInfo = jest.fn().mockResolvedValue(accountInfo);

        result = await commonHelper.getBalance(logger, binance, symbolInfo, 'buy');
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual({
          result: false,
          message: 'Balance is less than minimum notional.',
          freeBalance: 9
        });
      });
    });

    describe('when balance is available for buy', () => {
      beforeEach(async () => {
        const symbolInfo = require('./fixtures/helper-get-symbol-info1.json');
        symbolInfo.quoteAsset = 'USDT';

        const accountInfo = require('./fixtures/binance-account-info.json');
        accountInfo.balances = _.map(accountInfo.balances, b => {
          const balance = b;
          if (balance.asset === 'USDT') {
            balance.free = '19.00000';
          }
          return balance;
        });

        binance.client.accountInfo = jest.fn().mockResolvedValue(accountInfo);

        result = await commonHelper.getBalance(logger, binance, symbolInfo, 'buy');
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual({
          result: true,
          message: 'Balance found',
          freeBalance: 19
        });
      });
    });

    describe('when balance is available for sell', () => {
      beforeEach(async () => {
        const symbolInfo = require('./fixtures/helper-get-symbol-info1.json');
        symbolInfo.baseAsset = 'BTC';

        const accountInfo = require('./fixtures/binance-account-info.json');
        accountInfo.balances = _.map(accountInfo.balances, b => {
          const balance = b;
          if (balance.asset === 'BTC') {
            balance.free = '19.00000';
          }
          return balance;
        });

        binance.client.accountInfo = jest.fn().mockResolvedValue(accountInfo);

        result = await commonHelper.getBalance(logger, binance, symbolInfo, 'sell');
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual({
          result: true,
          message: 'Balance found',
          freeBalance: 19
        });
      });
    });
  });

  describe('getOrderQuantity', () => {
    describe('when tradeAction is buy', () => {
      describe('when order quantity is less than 0', () => {
        beforeEach(async () => {
          const symbolInfo = require('./fixtures/helper-get-symbol-info1.json');
          const balanceInfo = {
            freeBalance: 0.005
          };
          const indicators = {
            lastCandle: {
              close: '11756.2900000'
            }
          };

          result = commonHelper.getOrderQuantity(logger, symbolInfo, 'buy', balanceInfo, 100, indicators);
        });

        it('returns expected result', () => {
          expect(result).toStrictEqual({
            baseAssetPrice: 11756.29,
            freeBalance: 0.005,
            message: 'Order quantity is less or equal than 0.',
            orderQuantity: 0,
            result: false
          });
        });
      });

      describe('when order quantity is more than 0', () => {
        beforeEach(async () => {
          const symbolInfo = require('./fixtures/helper-get-symbol-info1.json');
          const balanceInfo = {
            freeBalance: 10
          };
          const indicators = {
            lastCandle: {
              close: '11756.2900000'
            }
          };

          result = commonHelper.getOrderQuantity(logger, symbolInfo, 'buy', balanceInfo, 100, indicators);
        });

        it('returns expected result', () => {
          expect(result).toStrictEqual({
            baseAssetPrice: 11756.29,
            freeBalance: 10,
            message: 'Calculated order quantity',
            orderQuantity: 0.00085,
            result: true
          });
        });
      });
    });

    describe('when tradeAction is sell', () => {
      describe('when order quantity is less than minimum quantity', () => {
        beforeEach(async () => {
          const symbolInfo = require('./fixtures/helper-get-symbol-info1.json');
          const balanceInfo = {
            freeBalance: 0.000001
          };
          const indicators = {
            lastCandle: {
              close: '11756.2900000'
            }
          };

          result = commonHelper.getOrderQuantity(logger, symbolInfo, 'sell', balanceInfo, 100, indicators);
        });

        it('returns expected result', () => {
          expect(result).toStrictEqual({
            result: false,
            freeBalance: 0.000001,
            message: 'Order quantity is less or equal than minimum quantity - 0.00000100.',
            orderQuantity: 0.000001,
            baseAssetPrice: 11756.29
          });
        });
      });

      describe('when order quantity is more than minimum quantity', () => {
        beforeEach(async () => {
          const symbolInfo = require('./fixtures/helper-get-symbol-info1.json');
          const balanceInfo = {
            freeBalance: 0.001
          };
          const indicators = {
            lastCandle: {
              close: '11756.2900000'
            }
          };

          result = commonHelper.getOrderQuantity(logger, symbolInfo, 'sell', balanceInfo, 100, indicators);
        });

        it('returns expected result', () => {
          expect(result).toStrictEqual({
            result: true,
            freeBalance: 0.001,
            message: 'Calculated order quantity',
            orderQuantity: 0.000999,
            baseAssetPrice: 11756.29
          });
        });
      });
    });
  });

  describe('getOrderPrice', () => {
    describe('when notional value is less than minimum notional value', () => {
      beforeEach(async () => {
        const symbolInfo = require('./fixtures/helper-get-symbol-info1.json');
        const orderQuantityInfo = {
          result: true,
          freeBalance: 0.0001,
          orderQuantity: 0.0001,
          baseAssetPrice: 11756.291561
        };

        result = commonHelper.getOrderPrice(logger, symbolInfo, orderQuantityInfo);
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({
          result: false,
          message: 'Notional value is less than minimum notional value.',
          orderPrice: 11756.29
        });
      });
    });

    describe('when notional value is more than minimum notional value', () => {
      beforeEach(async () => {
        const symbolInfo = require('./fixtures/helper-get-symbol-info1.json');
        const orderQuantityInfo = {
          result: true,
          freeBalance: 0.01,
          orderQuantity: 0.001,
          baseAssetPrice: 11756.291561
        };

        result = commonHelper.getOrderPrice(logger, symbolInfo, orderQuantityInfo);
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({
          result: true,
          message: `Calculated notional value`,
          orderPrice: 11756.29
        });
      });
    });
  });

  describe('getOpenOrders', () => {
    const openOrdersResult = require('./fixtures/binance-open-orders.json');
    beforeEach(async () => {
      binance.client.openOrders = jest.fn().mockResolvedValue(openOrdersResult);
      result = await commonHelper.getOpenOrders(logger, binance, 'BTCUSDT');
    });

    it('returns expected result', () => {
      expect(result).toStrictEqual(openOrdersResult);
    });
  });

  describe('placeStopLossLimitOrder', () => {
    const symbolInfo = require('./fixtures/helper-get-symbol-info1.json');
    const indicators = require('./fixtures/helper-indicators.json');
    const stopLossLimitInfo = {
      lastBuyPercentage: 1.03,
      stopPercentage: 0.99,
      limitPercentage: 0.98
    };

    beforeEach(() => {
      binance.client.order = jest.fn().mockResolvedValue({
        result: true
      });
      slack.sendMessage = jest.fn().mockResolvedValue();
    });

    describe('when quantity is less then minimum quantity', () => {
      beforeEach(async () => {
        const balanceInfo = {
          result: true,
          message: 'Balance found',
          freeBalance: 0.000001
        };

        result = await commonHelper.placeStopLossLimitOrder(
          logger,
          binance,
          slack,
          symbolInfo,
          balanceInfo,
          indicators,
          stopLossLimitInfo
        );
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({
          result: false,
          quantity: 0.000001,
          message: 'Order quantity is less or equal than minimum quantity - 0.00000100.'
        });
      });
    });

    describe('when notional value is less then minimum notional value', () => {
      beforeEach(async () => {
        const balanceInfo = {
          result: true,
          message: 'Balance found',
          freeBalance: 0.0008
        };

        result = await commonHelper.placeStopLossLimitOrder(
          logger,
          binance,
          slack,
          symbolInfo,
          balanceInfo,
          indicators,
          stopLossLimitInfo
        );
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({
          result: false,
          message: 'Notional value is less than minimum notional value.',
          minNotional: '10.00000000',
          notionValue: 9.212022560000001,
          price: 11529.44,
          quantity: 0.000799
        });
      });
    });

    describe('when order is good to go', () => {
      beforeEach(async () => {
        const balanceInfo = {
          result: true,
          message: 'Balance found',
          freeBalance: 0.001
        };

        result = await commonHelper.placeStopLossLimitOrder(
          logger,
          binance,
          slack,
          symbolInfo,
          balanceInfo,
          indicators,
          stopLossLimitInfo
        );
      });

      it('triggers binance.client.order', () => {
        expect(binance.client.order).toHaveBeenCalledWith({
          symbol: 'BTCUSDT',
          side: 'sell',
          type: 'STOP_LOSS_LIMIT',
          quantity: 0.000999,
          price: 11529.44,
          timeInForce: 'GTC',
          stopPrice: 11647.09
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
