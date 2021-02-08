/* eslint-disable global-require */
const _ = require('lodash');
const config = require('config');
const { binance, logger, cache, slack } = require('../../../helpers');

const simpleStopChaserHelper = require('../helper');

jest.mock('config');

describe('helper', () => {
  let result;

  beforeEach(() => {
    slack.sendMessage = jest.fn().mockResolvedValue(true);
  });

  describe('getConfiguration', () => {
    beforeEach(() => {
      cache.hset = jest.fn().mockResolvedValue(true);

      config.get = jest.fn(key => {
        if (key === 'jobs.simpleStopChaser') {
          return {
            enabled: true
          };
        }
        return null;
      });
    });

    describe('when cache value is not found', () => {
      beforeEach(async () => {
        cache.hget = jest.fn().mockResolvedValue(undefined);

        result = await simpleStopChaserHelper.getConfiguration(logger);
      });

      it('triggers cache.hget', () => {
        expect(cache.hget).toHaveBeenCalledWith(
          'simple-stop-chaser-common',
          'configuration'
        );
      });

      it('triggers config.get', () => {
        expect(config.get).toHaveBeenCalledWith('jobs.simpleStopChaser');
      });

      it('triggers cache.hset', () => {
        expect(cache.hset).toHaveBeenCalledWith(
          'simple-stop-chaser-common',
          'configuration',
          JSON.stringify({ enabled: true })
        );
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual({ enabled: true });
      });
    });

    describe('when cache value is found, but it is null', () => {
      beforeEach(async () => {
        cache.hget = jest.fn().mockResolvedValue(null);

        result = await simpleStopChaserHelper.getConfiguration(logger);
      });

      it('triggers cache.hget', () => {
        expect(cache.hget).toHaveBeenCalledWith(
          'simple-stop-chaser-common',
          'configuration'
        );
      });

      it('triggers config.get', () => {
        expect(config.get).toHaveBeenCalledWith('jobs.simpleStopChaser');
      });

      it('triggers cache.hset', () => {
        expect(cache.hset).toHaveBeenCalledWith(
          'simple-stop-chaser-common',
          'configuration',
          JSON.stringify({ enabled: true })
        );
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual({ enabled: true });
      });
    });

    describe('when cache value is found, but it is invalid json', () => {
      beforeEach(async () => {
        cache.hget = jest.fn().mockResolvedValue('something');

        result = await simpleStopChaserHelper.getConfiguration(logger);
      });

      it('triggers cache.hget', () => {
        expect(cache.hget).toHaveBeenCalledWith(
          'simple-stop-chaser-common',
          'configuration'
        );
      });

      it('triggers config.get', () => {
        expect(config.get).toHaveBeenCalledWith('jobs.simpleStopChaser');
      });

      it('triggers cache.hset', () => {
        expect(cache.hset).toHaveBeenCalledWith(
          'simple-stop-chaser-common',
          'configuration',
          JSON.stringify({ enabled: true })
        );
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual({ enabled: true });
      });
    });

    describe('when cache value is found, and valid', () => {
      beforeEach(async () => {
        cache.hget = jest.fn().mockResolvedValue(
          JSON.stringify({
            enabled: true,
            some: 'value'
          })
        );

        result = await simpleStopChaserHelper.getConfiguration(logger);
      });

      it('triggers cache.hget', () => {
        expect(cache.hget).toHaveBeenCalledWith(
          'simple-stop-chaser-common',
          'configuration'
        );
      });

      it('does not triggers config.get', () => {
        expect(config.get).not.toHaveBeenCalled();
      });

      it('does not triggers cache.hset', () => {
        expect(cache.hset).not.toHaveBeenCalled();
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual({ enabled: true, some: 'value' });
      });
    });
  });

  describe('cancelOpenOrders', () => {
    describe('success', () => {
      beforeEach(async () => {
        binance.client.cancelOpenOrders = jest.fn().mockResolvedValue(true);
        await simpleStopChaserHelper.cancelOpenOrders(logger, 'BTCUSDT');
      });

      it('triggers logger.info', () => {
        expect(logger.info).toHaveBeenCalledWith(
          { result: true },
          'Cancelled open orders'
        );
      });
    });

    describe('error', () => {
      const e = new Error('something happened');
      beforeEach(async () => {
        binance.client.cancelOpenOrders = jest.fn().mockRejectedValue(e);

        await simpleStopChaserHelper.cancelOpenOrders(logger, 'BTCUSDT');
      });

      it('triggers logger.info', () => {
        expect(logger.info).toHaveBeenCalledWith(
          { e },
          'Cancel result failed, but it is ok. Do not worry'
        );
      });
    });
  });

  describe('getSymbolInfo', () => {
    describe('when there is cached symbol info', () => {
      beforeEach(async () => {
        cache.hget = jest
          .fn()
          .mockResolvedValue(JSON.stringify({ some: 'value' }));
        result = await simpleStopChaserHelper.getSymbolInfo(logger, 'BTCUSDT');
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({ some: 'value' });
      });
    });

    describe('when there is no cached symbol info', () => {
      beforeEach(() => {
        cache.hget = jest.fn().mockResolvedValue(false);
        cache.hset = jest.fn().mockResolvedValue(true);
      });

      describe('when found symbol', () => {
        beforeEach(async () => {
          binance.client.exchangeInfo = jest
            .fn()
            .mockResolvedValue(
              require('./fixtures/binance-exchange-info.json')
            );

          result = await simpleStopChaserHelper.getSymbolInfo(
            logger,
            'BTCUSDT'
          );
        });

        it('returns expected value', () => {
          expect(result).toStrictEqual(
            require('./fixtures/helper-get-symbol-info1.json')
          );
        });
      });

      describe('when does not find symbol', () => {
        beforeEach(async () => {
          binance.client.exchangeInfo = jest
            .fn()
            .mockResolvedValue(
              require('./fixtures/binance-exchange-info.json')
            );

          result = await simpleStopChaserHelper.getSymbolInfo(
            logger,
            'BTCUNKNW'
          );
        });

        it('returns expected value', () => {
          expect(result).toStrictEqual(
            require('./fixtures/helper-get-symbol-info2.json')
          );
        });
      });
    });
  });

  describe('getBuyBalance', () => {
    const orgAccountInfo = require('./fixtures/binance-account-info.json');
    const orgIndicators = require('./fixtures/helper-indicators.json');

    describe('when cannot find balance', () => {
      beforeEach(async () => {
        binance.client.accountInfo = jest
          .fn()
          .mockResolvedValue(orgAccountInfo);
        const indicators = _.cloneDeep(orgIndicators);

        indicators.symbolInfo.quoteAsset = 'UNKNWN';
        indicators.symbolInfo.baseAsset = 'UNKNWN';

        result = await simpleStopChaserHelper.getBuyBalance(
          logger,
          indicators,
          { maxPurchaseAmount: 100 }
        );
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual({
          result: false,
          message: 'Balance is not found. Cannot place an order.',
          quoteAssetBalance: {},
          baseAssetBalance: {}
        });
      });
    });

    describe('when base asset balance is more than minimum notional value', () => {
      beforeEach(async () => {
        const accountInfo = _.cloneDeep(orgAccountInfo);
        accountInfo.balances = _.map(accountInfo.balances, b => {
          const balance = b;
          if (balance.asset === 'BTC') {
            balance.free = '0.01000';
          }
          return balance;
        });
        binance.client.accountInfo = jest.fn().mockResolvedValue(accountInfo);

        const indicators = _.cloneDeep(orgIndicators);

        result = await simpleStopChaserHelper.getBuyBalance(
          logger,
          indicators,
          { maxPurchaseAmount: 100 }
        );
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual({
          result: false,
          message:
            'Base asset does not have enough balance to place stop loss limit order. Cannot place an order.',
          baseAsset: 'BTC',
          baseAssetTotalBalance: 0.01,
          currentBalanceInQuoteAsset: 117.6474,
          lastCandleClose: 11764.74,
          minNotional: '10.00000000'
        });
      });
    });

    describe('when balance is less than minimum notional value', () => {
      beforeEach(async () => {
        const accountInfo = _.cloneDeep(orgAccountInfo);
        accountInfo.balances = _.map(accountInfo.balances, b => {
          const balance = b;
          if (balance.asset === 'USDT') {
            balance.free = '9.00000';
          }
          return balance;
        });

        binance.client.accountInfo = jest.fn().mockResolvedValue(accountInfo);

        const indicators = _.cloneDeep(orgIndicators);
        indicators.symbolInfo.quoteAsset = 'USDT';

        result = await simpleStopChaserHelper.getBuyBalance(
          logger,
          indicators,
          { maxPurchaseAmount: 100 }
        );
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual({
          result: false,
          message:
            'Balance is less than minimum notional. Cannot place an order.',
          freeBalance: 9
        });
      });
    });

    describe('when quote asset balance is more than max purchase amount', () => {
      beforeEach(async () => {
        const accountInfo = _.cloneDeep(orgAccountInfo);
        accountInfo.balances = _.map(accountInfo.balances, b => {
          const balance = b;
          if (balance.asset === 'USDT') {
            balance.free = '119.00000';
          }
          return balance;
        });

        binance.client.accountInfo = jest.fn().mockResolvedValue(accountInfo);
        const indicators = _.cloneDeep(orgIndicators);

        result = await simpleStopChaserHelper.getBuyBalance(
          logger,
          indicators,
          {
            maxPurchaseAmount: 100
          }
        );
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual({
          result: true,
          message: 'Balance found',
          freeBalance: 100
        });
      });
    });

    describe('when balance is available for buy', () => {
      beforeEach(async () => {
        const accountInfo = _.cloneDeep(orgAccountInfo);
        accountInfo.balances = _.map(accountInfo.balances, b => {
          const balance = b;
          if (balance.asset === 'USDT') {
            balance.free = '19.00000';
          }
          return balance;
        });

        binance.client.accountInfo = jest.fn().mockResolvedValue(accountInfo);
        const indicators = _.cloneDeep(orgIndicators);
        indicators.symbolInfo.quoteAsset = 'USDT';

        result = await simpleStopChaserHelper.getBuyBalance(
          logger,
          indicators,
          { maxPurchaseAmount: 100 }
        );
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

  describe('getSellBalance', () => {
    const orgSymbolInfo = require('./fixtures/helper-get-symbol-info1.json');
    const orgSymbolInfoDOTUSDT = require('./fixtures/helper-get-symbol-info3.json');
    const orgAccountInfo = require('./fixtures/binance-account-info.json');
    const orgIndicators = require('./fixtures/helper-indicators.json');

    const stopLossLimitConfig = {
      lastBuyPercentage: 1.03,
      stopPercentage: 0.99,
      limitPercentage: 0.98
    };

    beforeEach(() => {
      cache.hdel = jest.fn().mockResolvedValue(true);
    });

    describe('when cannot find balance', () => {
      beforeEach(async () => {
        binance.client.accountInfo = jest
          .fn()
          .mockResolvedValue(orgAccountInfo);

        const symbolInfo = _.cloneDeep(orgSymbolInfo);
        symbolInfo.baseAsset = 'UNKNWN';

        const indicators = _.cloneDeep(orgIndicators);

        result = await simpleStopChaserHelper.getSellBalance(
          logger,
          symbolInfo,
          indicators,
          stopLossLimitConfig
        );
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual({
          result: false,
          message: 'Balance is not found. Cannot place an order.',
          baseAssetBalance: {}
        });
      });
    });

    describe('when base asset balance is found', () => {
      describe('when base asset had no free balance, but has not enough locked balance', () => {
        describe('when not enough quantity', () => {
          beforeEach(async () => {
            const accountInfo = _.cloneDeep(orgAccountInfo);
            accountInfo.balances = _.map(accountInfo.balances, b => {
              const balance = b;
              if (balance.asset === 'BTC') {
                balance.free = '0.00000';
                balance.locked = '0.00000100';
              }
              return balance;
            });
            binance.client.accountInfo = jest
              .fn()
              .mockResolvedValue(accountInfo);

            const symbolInfo = _.cloneDeep(orgSymbolInfo);
            const indicators = _.cloneDeep(orgIndicators);

            result = await simpleStopChaserHelper.getSellBalance(
              logger,
              symbolInfo,
              indicators,
              stopLossLimitConfig
            );
          });

          it('triggers cache.hdel', () => {
            expect(cache.hdel).toHaveBeenCalledWith(
              'simple-stop-chaser-symbols',
              'BTCUSDT-last-buy-price'
            );
          });

          it('returns expected value', () => {
            expect(result).toStrictEqual({
              result: false,
              message:
                'Balance found, but not enough to sell. Delete last buy price.',
              freeBalance: 0,
              lockedBalance: 0.000001
            });
          });
        });

        describe('when less than minimum notional value', () => {
          beforeEach(async () => {
            const accountInfo = _.cloneDeep(orgAccountInfo);
            accountInfo.balances = _.map(accountInfo.balances, b => {
              const balance = b;
              if (balance.asset === 'BTC') {
                balance.free = '0.00000';
                balance.locked = '0.000700';
              }
              return balance;
            });
            binance.client.accountInfo = jest
              .fn()
              .mockResolvedValue(accountInfo);

            const symbolInfo = _.cloneDeep(orgSymbolInfo);
            const indicators = _.cloneDeep(orgIndicators);

            result = await simpleStopChaserHelper.getSellBalance(
              logger,
              symbolInfo,
              indicators,
              stopLossLimitConfig
            );
          });

          it('triggers cache.hdel', () => {
            expect(cache.hdel).toHaveBeenCalledWith(
              'simple-stop-chaser-symbols',
              'BTCUSDT-last-buy-price'
            );
          });

          it('returns expected value', () => {
            expect(result).toStrictEqual({
              result: false,
              message:
                'Balance found, but notional value is less than minimum notional value. Delete last buy price.',
              freeBalance: 0,
              lockedBalance: 0.0007
            });
          });
        });

        describe('when has enough quantity to sell', () => {
          beforeEach(async () => {
            const accountInfo = _.cloneDeep(orgAccountInfo);
            accountInfo.balances = _.map(accountInfo.balances, b => {
              const balance = b;
              if (balance.asset === 'BTC') {
                balance.free = '0.00000';
                balance.locked = '0.00100';
              }
              return balance;
            });
            binance.client.accountInfo = jest
              .fn()
              .mockResolvedValue(accountInfo);

            const symbolInfo = _.cloneDeep(orgSymbolInfo);
            const indicators = _.cloneDeep(orgIndicators);

            result = await simpleStopChaserHelper.getSellBalance(
              logger,
              symbolInfo,
              indicators,
              stopLossLimitConfig
            );
          });

          it('does not trigger cache.hdel', () => {
            expect(cache.hdel).not.toHaveBeenCalled();
          });

          it('returns expected value', () => {
            expect(result).toStrictEqual({
              result: true,
              message: 'Balance found',
              freeBalance: 0,
              lockedBalance: 0.001
            });
          });
        });
      });

      describe('when base asset had some free/locked balance', () => {
        describe('when not enough quantity', () => {
          beforeEach(async () => {
            const accountInfo = _.cloneDeep(orgAccountInfo);
            accountInfo.balances = _.map(accountInfo.balances, b => {
              const balance = b;
              if (balance.asset === 'BTC') {
                balance.free = '0.000000200';
                balance.locked = '0.00000100';
              }
              return balance;
            });
            binance.client.accountInfo = jest
              .fn()
              .mockResolvedValue(accountInfo);

            const symbolInfo = _.cloneDeep(orgSymbolInfo);
            const indicators = _.cloneDeep(orgIndicators);

            result = await simpleStopChaserHelper.getSellBalance(
              logger,
              symbolInfo,
              indicators,
              stopLossLimitConfig
            );
          });

          it('triggers cache.hdel', () => {
            expect(cache.hdel).toHaveBeenCalledWith(
              'simple-stop-chaser-symbols',
              'BTCUSDT-last-buy-price'
            );
          });

          it('returns expected value', () => {
            expect(result).toStrictEqual({
              result: false,
              message:
                'Balance found, but not enough to sell. Delete last buy price.',
              freeBalance: 0,
              lockedBalance: 0.000001
            });
          });
        });

        describe('when less than minimum notional value', () => {
          beforeEach(async () => {
            const accountInfo = _.cloneDeep(orgAccountInfo);
            accountInfo.balances = _.map(accountInfo.balances, b => {
              const balance = b;
              if (balance.asset === 'BTC') {
                balance.free = '0.0000100';
                balance.locked = '0.000700';
              }
              return balance;
            });
            binance.client.accountInfo = jest
              .fn()
              .mockResolvedValue(accountInfo);

            const symbolInfo = _.cloneDeep(orgSymbolInfo);
            const indicators = _.cloneDeep(orgIndicators);

            result = await simpleStopChaserHelper.getSellBalance(
              logger,
              symbolInfo,
              indicators,
              stopLossLimitConfig
            );
          });

          it('triggers cache.hdel', () => {
            expect(cache.hdel).toHaveBeenCalledWith(
              'simple-stop-chaser-symbols',
              'BTCUSDT-last-buy-price'
            );
          });

          it('returns expected value', () => {
            expect(result).toStrictEqual({
              result: false,
              message:
                'Balance found, but notional value is less than minimum notional value. Delete last buy price.',
              freeBalance: 0.00001,
              lockedBalance: 0.0007
            });
          });
        });

        describe('when has enough quantity to sell', () => {
          beforeEach(async () => {
            const accountInfo = _.cloneDeep(orgAccountInfo);
            accountInfo.balances = _.map(accountInfo.balances, b => {
              const balance = b;
              if (balance.asset === 'BTC') {
                balance.free = '0.0010';
                balance.locked = '0.0001';
              }
              return balance;
            });
            binance.client.accountInfo = jest
              .fn()
              .mockResolvedValue(accountInfo);

            const symbolInfo = _.cloneDeep(orgSymbolInfo);
            const indicators = _.cloneDeep(orgIndicators);

            result = await simpleStopChaserHelper.getSellBalance(
              logger,
              symbolInfo,
              indicators,
              stopLossLimitConfig
            );
          });

          it('does not trigger cache.hdel', () => {
            expect(cache.hdel).not.toHaveBeenCalled();
          });

          it('returns expected value', () => {
            expect(result).toStrictEqual({
              result: true,
              message: 'Balance found',
              freeBalance: 0.001,
              lockedBalance: 0.0001
            });
          });
        });
      });

      describe('when has enough quantity to sell -no round', () => {
        beforeEach(async () => {
          const accountInfo = _.cloneDeep(orgAccountInfo);
          accountInfo.balances = _.map(accountInfo.balances, b => {
            const balance = b;
            if (balance.asset === 'DOTUP') {
              balance.free = '1.5984';
              balance.locked = '0.0000';
            }
            return balance;
          });
          binance.client.accountInfo = jest.fn().mockResolvedValue(accountInfo);

          const symbolInfo = _.cloneDeep(orgSymbolInfoDOTUSDT);
          const indicators = _.cloneDeep(orgIndicators);

          result = await simpleStopChaserHelper.getSellBalance(
            logger,
            symbolInfo,
            indicators,
            stopLossLimitConfig
          );
        });

        it('does not trigger cache.hdel', () => {
          expect(cache.hdel).not.toHaveBeenCalled();
        });

        it('returns expected value', () => {
          expect(result).toStrictEqual({
            result: true,
            message: 'Balance found',
            freeBalance: 1.59,
            lockedBalance: 0.0
          });
        });
      });
    });
  });

  describe('getBuyOrderQuantity', () => {
    const orgSymbolInfo = require('./fixtures/helper-get-symbol-info1.json');

    describe('when order quantity is less than 0', () => {
      beforeEach(async () => {
        const symbolInfo = _.cloneDeep(orgSymbolInfo);
        const balanceInfo = {
          freeBalance: 0.005
        };
        const indicators = {
          lastCandle: {
            close: '11756.2900000'
          }
        };

        result = simpleStopChaserHelper.getBuyOrderQuantity(
          logger,
          symbolInfo,
          balanceInfo,
          indicators
        );
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({
          result: false,
          message:
            'Order quantity is less or equal than 0. Do not place an order.',
          baseAssetPrice: 11756.29,
          orderQuantity: 0,
          freeBalance: 0.005
        });
      });
    });

    describe('when order quantity is more than 0', () => {
      beforeEach(async () => {
        const symbolInfo = _.cloneDeep(orgSymbolInfo);
        const balanceInfo = {
          freeBalance: 10
        };
        const indicators = {
          lastCandle: {
            close: '11756.2900000'
          }
        };

        result = simpleStopChaserHelper.getBuyOrderQuantity(
          logger,
          symbolInfo,
          balanceInfo,
          indicators
        );
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({
          result: true,
          message: 'Calculated order quantity to buy.',
          baseAssetPrice: 11756.29,
          orderQuantity: 0.000849,
          freeBalance: 10
        });
      });
    });
  });

  describe('getBuyOrderPrice', () => {
    const orgSymbolInfo = require('./fixtures/helper-get-symbol-info1.json');

    describe('when notional value is less than minimum notional value', () => {
      beforeEach(async () => {
        const symbolInfo = _.cloneDeep(orgSymbolInfo);
        const orderQuantityInfo = {
          result: true,
          baseAssetPrice: 11756.291561,
          orderQuantity: 0.0001,
          freeBalance: 0.0001
        };

        result = simpleStopChaserHelper.getBuyOrderPrice(
          logger,
          symbolInfo,
          orderQuantityInfo
        );
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({
          result: false,
          message: `Notional value is less than minimum notional value. Do not place an order.`,
          orderPrice: 11756.29
        });
      });
    });

    describe('when notional value is more than minimum notional value', () => {
      beforeEach(async () => {
        const symbolInfo = _.cloneDeep(orgSymbolInfo);
        const orderQuantityInfo = {
          result: true,
          baseAssetPrice: 11756.291561,
          orderQuantity: 0.001,
          freeBalance: 0.01
        };

        result = simpleStopChaserHelper.getBuyOrderPrice(
          logger,
          symbolInfo,
          orderQuantityInfo
        );
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
      result = await simpleStopChaserHelper.getOpenOrders(logger, 'BTCUSDT');
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

        result = await simpleStopChaserHelper.placeStopLossLimitOrder(
          logger,
          symbolInfo,
          balanceInfo,
          indicators,
          stopLossLimitInfo
        );
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({
          result: false,
          message:
            'Order quantity is less or equal than minimum quantity - 0.00000100. Do not place an order.',
          quantity: 0
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

        result = await simpleStopChaserHelper.placeStopLossLimitOrder(
          logger,
          symbolInfo,
          balanceInfo,
          indicators,
          stopLossLimitInfo
        );
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({
          result: false,
          message:
            'Notional value is less than minimum notional value. Do not place an order.',
          quantity: 0.000799,
          price: 11529.44,
          notionValue: 9.212022560000001,
          minNotional: 10.0
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

        result = await simpleStopChaserHelper.placeStopLossLimitOrder(
          logger,
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
          result: true,
          message: `Placed stop loss order.`,
          orderParams: {
            price: 11529.44,
            quantity: 0.000999,
            side: 'sell',
            stopPrice: 11647.09,
            symbol: 'BTCUSDT',
            timeInForce: 'GTC',
            type: 'STOP_LOSS_LIMIT'
          },
          orderResult: {
            result: true
          }
        });
      });
    });
  });

  describe('getAccountInfo', () => {
    beforeEach(async () => {
      binance.client.accountInfo = jest.fn().mockResolvedValue({
        updateTime: '1611365234776',
        balances: [
          { asset: 'BTC', free: '0.00100000', locked: '0.99900000' },
          { asset: 'ETH', free: '0.00000000', locked: '0.00000000' }
        ]
      });

      result = await simpleStopChaserHelper.getAccountInfo(logger);
    });

    it('return expected result', () => {
      expect(result).toStrictEqual({
        updateTime: '1611365234776',
        balances: [{ asset: 'BTC', free: '0.00100000', locked: '0.99900000' }]
      });
    });
  });

  describe('getIndicators', () => {
    const orgIndicators = require('./fixtures/helper-get-indicators.json');
    const orgCandles = require('./fixtures/binance-candles.json');
    const orgExchangeInfo = require('./fixtures/binance-exchange-info.json');

    beforeEach(async () => {
      config.get = jest.fn(key => {
        switch (key) {
          case 'jobs.simpleStopChaser':
            return {
              enabled: false,
              cronTime: '* * * * * *',
              symbols: ['BTCUSDT'],
              candles: {
                interval: '4h',
                limit: 100
              },
              stopLossLimit: {
                lastBuyPercentage: 1.06,
                stopPercentage: 0.97,
                limitPercentage: 0.96
              }
            };
          default:
            return '';
        }
      });

      binance.client.candles = jest.fn().mockResolvedValue(orgCandles);

      binance.client.exchangeInfo = jest
        .fn()
        .mockResolvedValue(orgExchangeInfo);

      result = await simpleStopChaserHelper.getIndicators('BTCUSDT', logger);
    });

    it('returns expected result', () => {
      expect(result).toStrictEqual(orgIndicators);
    });
  });

  describe('determineAction', () => {
    const orgIndicators = require('./fixtures/helper-get-indicators.json');

    describe('when lowest closed value is less than last closed value', () => {
      beforeEach(async () => {
        const indicators = _.cloneDeep(orgIndicators);
        indicators.lastCandle.close = '15665.0000';
        indicators.lowestClosed = 16000;
        result = await simpleStopChaserHelper.determineAction(
          logger,
          indicators
        );
      });

      it('returns expected result', () => {
        expect(result.symbol).toEqual('BTCUSDT');
        expect(result.action).toEqual('buy');
        expect(result.lastCandleClose).toEqual('15665.0000');
        expect(result.lowestClosed).toEqual(16000);
      });
    });

    describe('when lowest closed value is higher than last closed value', () => {
      beforeEach(async () => {
        const indicators = _.cloneDeep(orgIndicators);
        indicators.lastCandle.close = '16000.0000';
        indicators.lowestClosed = 15665;
        result = await simpleStopChaserHelper.determineAction(
          logger,
          indicators
        );
      });

      it('returns expected result', () => {
        expect(result.symbol).toEqual('BTCUSDT');
        expect(result.action).toEqual('wait');
        expect(result.lastCandleClose).toEqual('16000.0000');
        expect(result.lowestClosed).toEqual(15665);
      });
    });
  });

  describe('placeBuyOrder', () => {
    const orgAccountInfo = require('./fixtures/binance-account-info.json');
    const orgIndicators = require('./fixtures/helper-indicators.json');
    const orgExchangeInfo = require('./fixtures/binance-exchange-info.json');

    beforeEach(() => {
      config.get = jest.fn(key => {
        switch (key) {
          case 'jobs.simpleStopChaser.maxPurchaseAmount':
            return 100;
          default:
            return '';
        }
      });

      cache.hset = jest.fn().mockResolvedValue(true);

      binance.client.order = jest.fn().mockResolvedValue(true);

      binance.client.cancelOpenOrders = jest.fn().mockResolvedValue(true);

      binance.client.exchangeInfo = jest
        .fn()
        .mockResolvedValue(orgExchangeInfo);
    });

    describe('when fail to get buy balance', () => {
      beforeEach(async () => {
        const accountInfo = _.cloneDeep(orgAccountInfo);
        binance.client.accountInfo = jest.fn().mockResolvedValue(accountInfo);

        const indicators = _.cloneDeep(orgIndicators);
        indicators.symbolInfo.quoteAsset = 'UNKNWN';
        indicators.symbolInfo.baseAsset = 'UNKNWN';

        result = await simpleStopChaserHelper.placeBuyOrder(logger, indicators);
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({
          result: false,
          message: 'Balance is not found. Cannot place an order.',
          baseAssetBalance: {},
          quoteAssetBalance: {}
        });
      });
    });

    describe('when fail to get buy quantity to order', () => {
      beforeEach(async () => {
        const indicators = _.cloneDeep(orgIndicators);

        // Force to set unexpected step size for causing an error with getBuyOrderQuantity
        indicators.symbolInfo.filterLotSize.stepSize = '0.1';

        const accountInfo = _.cloneDeep(orgAccountInfo);
        accountInfo.balances = _.map(accountInfo.balances, b => {
          const balance = b;
          if (balance.asset === 'USDT') {
            balance.free = '10.00001';
          }
          return balance;
        });

        binance.client.accountInfo = jest.fn().mockResolvedValue(accountInfo);

        result = await simpleStopChaserHelper.placeBuyOrder(logger, indicators);
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({
          result: false,
          message:
            'Order quantity is less or equal than 0. Do not place an order.',
          baseAssetPrice: 11764.74,
          freeBalance: 10,
          orderQuantity: 0
        });
      });
    });

    describe('when fail to get buy order price to roder', () => {
      beforeEach(async () => {
        const indicators = _.cloneDeep(orgIndicators);

        const accountInfo = _.cloneDeep(orgAccountInfo);
        accountInfo.balances = _.map(accountInfo.balances, b => {
          const balance = b;
          if (balance.asset === 'USDT') {
            balance.free = '10.0001';
          }
          return balance;
        });
        binance.client.accountInfo = jest.fn().mockResolvedValue(accountInfo);

        result = await simpleStopChaserHelper.placeBuyOrder(logger, indicators);
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({
          result: false,
          message:
            'Notional value is less than minimum notional value. Do not place an order.',
          orderPrice: 11764.74
        });
      });
    });

    describe('when good to buy order', () => {
      beforeEach(async () => {
        const indicators = _.cloneDeep(orgIndicators);

        const accountInfo = _.cloneDeep(orgAccountInfo);
        accountInfo.balances = _.map(accountInfo.balances, b => {
          const balance = b;
          if (balance.asset === 'USDT') {
            balance.free = '11';
          }
          return balance;
        });
        binance.client.accountInfo = jest.fn().mockResolvedValue(accountInfo);

        result = await simpleStopChaserHelper.placeBuyOrder(logger, indicators);
      });

      it('triggers binance.client.order', () => {
        expect(binance.client.order).toHaveBeenCalledWith({
          price: 11764.74,
          quantity: 0.000934,
          side: 'buy',
          symbol: 'BTCUSDT',
          timeInForce: 'GTC',
          type: 'LIMIT'
        });
      });

      it('triggers cache.hset', () => {
        expect(cache.hset).toHaveBeenCalledWith(
          'simple-stop-chaser-symbols',
          'BTCUSDT-last-buy-price',
          11764.74
        );
      });

      it('returns expected result', () => {
        expect(result).toBeTruthy();
      });
    });
  });

  describe('chaseStopLossLimitOrder', () => {
    const orgAccountInfo = require('./fixtures/binance-account-info.json');
    const orgIndicators = require('./fixtures/helper-indicators.json');
    const orgExchangeInfo = require('./fixtures/binance-exchange-info.json');

    let stopLossLimit;

    beforeEach(() => {
      stopLossLimit = {
        lastBuyPercentage: 1.03,
        stopPercentage: 0.99,
        limitPercentage: 0.98
      };

      config.get = jest.fn(key => {
        switch (key) {
          case 'jobs.simpleStopChaser':
            return {
              stopLossLimit
            };
          default:
            return '';
        }
      });
      binance.client.cancelOpenOrders = jest.fn().mockResolvedValue(true);

      binance.client.exchangeInfo = jest
        .fn()
        .mockResolvedValue(orgExchangeInfo);
    });

    describe('when there is no open order', () => {
      beforeEach(() => {
        binance.client.openOrders = jest.fn().mockResolvedValue([]);

        cache.hset = jest.fn().mockResolvedValue(true);
        binance.client.order = jest.fn().mockResolvedValue(true);
      });

      describe('when there is no balance', () => {
        beforeEach(async () => {
          const accountInfo = _.cloneDeep(orgAccountInfo);
          binance.client.accountInfo = jest.fn().mockResolvedValue(accountInfo);

          const indicators = _.cloneDeep(orgIndicators);
          indicators.symbolInfo.baseAsset = 'UNKNWN';

          result = await simpleStopChaserHelper.chaseStopLossLimitOrder(
            logger,
            indicators
          );
        });

        it('returns expected result', () => {
          expect(result).toStrictEqual({
            result: false,
            baseAssetBalance: {},
            message: 'Balance is not found. Cannot place an order.'
          });
        });
      });

      describe('when last buy price is not cached', () => {
        beforeEach(async () => {
          const accountInfo = _.cloneDeep(orgAccountInfo);
          accountInfo.balances = _.map(accountInfo.balances, b => {
            const balance = b;
            if (balance.asset === 'BTC') {
              balance.free = '0.01000';
            }
            return balance;
          });
          binance.client.accountInfo = jest.fn().mockResolvedValue(accountInfo);

          cache.hget = jest.fn().mockResolvedValue(undefined);

          const indicators = _.cloneDeep(orgIndicators);

          result = await simpleStopChaserHelper.chaseStopLossLimitOrder(
            logger,
            indicators
          );
        });

        it('triggers binance.client.order', () => {
          expect(binance.client.order).toHaveBeenCalledWith({
            price: 11529.44,
            quantity: 0.00999,
            side: 'sell',
            stopPrice: 11647.09,
            symbol: 'BTCUSDT',
            timeInForce: 'GTC',
            type: 'STOP_LOSS_LIMIT'
          });
        });

        it('returns expected result', () => {
          expect(result).toBeTruthy();
        });
      });

      describe('when last buy price is cached', () => {
        beforeEach(async () => {
          const accountInfo = _.cloneDeep(orgAccountInfo);
          accountInfo.balances = _.map(accountInfo.balances, b => {
            const balance = b;
            if (balance.asset === 'BTC') {
              balance.free = '0.01000';
            }
            return balance;
          });
          binance.client.accountInfo = jest.fn().mockResolvedValue(accountInfo);
        });

        describe('when closed price is lower than minimum selling price', () => {
          beforeEach(async () => {
            cache.hget = jest.fn().mockImplementation((key, field) => {
              if (
                key === 'simple-stop-chaser-common' &&
                field === 'configuration'
              ) {
                return {
                  stopLossLimit
                };
              }

              if (
                key === 'simple-stop-chaser-symbols' &&
                field === 'BTCUSDT-last-buy-price'
              ) {
                return 12044;
              }

              return '';
            });

            const indicators = _.cloneDeep(orgIndicators);

            result = await simpleStopChaserHelper.chaseStopLossLimitOrder(
              logger,
              indicators
            );
          });

          it('returns expected result', () => {
            expect(result.result).toBeFalsy();
            expect(result.message).toEqual(
              'Current price is lower than minimum selling price. Wait.'
            );
            expect(result.lastCandleClose).toEqual(11764.74);
            expect(result.lastBuyPrice).toEqual(12044);
            expect(result.calculatedLastBuyPrice).toEqual(12405.32);
          });
        });

        describe('when closed price is more than minimum selling price', () => {
          beforeEach(async () => {
            cache.hget = jest.fn().mockImplementation((key, field) => {
              if (
                key === 'simple-stop-chaser-common' &&
                field === 'configuration'
              ) {
                return {
                  stopLossLimit
                };
              }

              if (
                key === 'simple-stop-chaser-symbols' &&
                field === 'BTCUSDT-last-buy-price'
              ) {
                return 11411;
              }

              return '';
            });

            const indicators = _.cloneDeep(orgIndicators);

            result = await simpleStopChaserHelper.chaseStopLossLimitOrder(
              logger,
              indicators
            );
          });

          it('triggers binance.client.order', () => {
            expect(binance.client.order).toHaveBeenCalledWith({
              price: 11529.44,
              quantity: 0.00999,
              side: 'sell',
              stopPrice: 11647.09,
              symbol: 'BTCUSDT',
              timeInForce: 'GTC',
              type: 'STOP_LOSS_LIMIT'
            });
          });

          it('returns expected result', () => {
            expect(result).toBeTruthy();
          });
        });
      });
    });

    describe('when there is a open order', () => {
      beforeEach(() => {
        cache.hset = jest.fn().mockResolvedValue(true);
        binance.client.order = jest.fn().mockResolvedValue(true);
      });

      describe('when last order is not STOP_LOSS_LIMIT', () => {
        beforeEach(async () => {
          binance.client.openOrders = jest.fn().mockResolvedValue([
            {
              type: 'LIMIT',
              stopPrice: '0.0000'
            }
          ]);

          const indicators = _.cloneDeep(orgIndicators);

          result = await simpleStopChaserHelper.chaseStopLossLimitOrder(
            logger,
            indicators
          );
        });

        it('returns expected result', () => {
          expect(result).toStrictEqual({
            result: false,
            message: 'Order is not STOP_LOSS_LIMIT, Do nothing.'
          });
        });
      });

      describe('when order stop price is less than limit percentage', () => {
        beforeEach(async () => {
          const indicators = _.cloneDeep(orgIndicators);

          indicators.lastCandle.close = '12600.00';
          binance.client.openOrders = jest.fn().mockResolvedValue([
            {
              type: 'STOP_LOSS_LIMIT',
              stopPrice: 11529.44
            }
          ]);

          result = await simpleStopChaserHelper.chaseStopLossLimitOrder(
            logger,
            indicators
          );
        });

        it('triggers binance.client.cancelOpenOrders', () => {
          expect(binance.client.cancelOpenOrders).toHaveBeenCalledWith({
            symbol: 'BTCUSDT'
          });
        });

        it('returns expected result', () => {
          expect(result).toStrictEqual({
            result: true,
            message: 'Finished to process chaseStopLossLimitOrder.'
          });
        });
      });

      describe('when order stop price is more than limit percentage', () => {
        beforeEach(async () => {
          const indicators = _.cloneDeep(orgIndicators);

          indicators.lastCandle.close = '11300.00';

          binance.client.openOrders = jest.fn().mockResolvedValue([
            {
              type: 'STOP_LOSS_LIMIT',
              stopPrice: 11529.44
            }
          ]);

          result = await simpleStopChaserHelper.chaseStopLossLimitOrder(
            logger,
            indicators
          );
        });

        it('does not trigger commonHelper.cancelOpenOrders', () => {
          expect(binance.client.cancelOpenOrders).not.toHaveBeenCalled();
        });

        it('returns expected result', () => {
          expect(result).toStrictEqual({
            result: true,
            message: 'Finished to process chaseStopLossLimitOrder.'
          });
        });
      });
    });
  });
});
