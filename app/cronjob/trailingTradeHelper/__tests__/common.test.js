/* eslint-disable global-require */

describe('common.js', () => {
  let commonHelper;

  let cacheMock;
  let binanceMock;
  let mongoMock;
  let loggerMock;

  let result;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();
  });

  describe('cacheExchangeSymbols', () => {
    describe('when there is no cached exchange info and no cached exchange info', () => {
      beforeEach(async () => {
        const { cache, binance, logger } = require('../../../helpers');

        cacheMock = cache;
        binanceMock = binance;

        cacheMock.hget = jest.fn().mockResolvedValue(null);
        cacheMock.hset = jest.fn().mockResolvedValue(true);

        binanceMock.client.exchangeInfo = jest
          .fn()
          .mockResolvedValue(require('./fixtures/binance-exchange-info.json'));

        commonHelper = require('../common');
        await commonHelper.cacheExchangeSymbols(logger, {});
      });

      it('triggers cache.hget for exchange symbols', () => {
        expect(cacheMock.hget).toHaveBeenCalledWith(
          'trailing-trade-common',
          'exchange-symbols'
        );
      });

      it('triggers cache.hget for exchange info', () => {
        expect(cacheMock.hget).toHaveBeenCalledWith(
          'trailing-trade-common',
          'exchange-info'
        );
      });

      it('triggers binance exchange info', () => {
        expect(binanceMock.client.exchangeInfo).toHaveBeenCalled();
      });

      it('triggers cache.hset for exchange info', () => {
        expect(cacheMock.hset).toHaveBeenCalledWith(
          'trailing-trade-common',
          'exchange-info',
          JSON.stringify(require('./fixtures/binance-exchange-info.json'))
        );
      });

      it('triggers cache.hset for exchange symbols', () => {
        expect(cacheMock.hset).toHaveBeenCalledWith(
          'trailing-trade-common',
          'exchange-symbols',
          JSON.stringify(
            require('./fixtures/binance-cached-exchange-symbols.json')
          )
        );
      });
    });

    describe('when there is cached exchange info', () => {
      describe('when cached exchange symbol is not valid', () => {
        beforeEach(async () => {
          const { cache, binance, logger } = require('../../../helpers');

          cacheMock = cache;
          binanceMock = binance;

          cacheMock.hget = jest.fn().mockImplementation((hash, key) => {
            if (
              hash === 'trailing-trade-common' &&
              key === 'exchange-symbols'
            ) {
              return JSON.stringify(
                require('./fixtures/binance-cached-not-valid-exchange-symbols.json')
              );
            }
            if (hash === 'trailing-trade-common' && key === 'exchange-info') {
              return JSON.stringify(
                require('./fixtures/binance-exchange-info.json')
              );
            }

            return null;
          });
          cacheMock.hset = jest.fn().mockResolvedValue(true);

          binanceMock.client.exchangeInfo = jest.fn().mockResolvedValue(null);

          commonHelper = require('../common');
          await commonHelper.cacheExchangeSymbols(logger, {
            supportFIATs: ['USDT', 'BUSD']
          });
        });

        it('triggers cache.hget for exchange symbols', () => {
          expect(cacheMock.hget).toHaveBeenCalledWith(
            'trailing-trade-common',
            'exchange-symbols'
          );
        });

        it('triggers cache.hget for exchange info', () => {
          expect(cacheMock.hget).toHaveBeenCalledWith(
            'trailing-trade-common',
            'exchange-info'
          );
        });

        it('does not trigger binance exchange info', () => {
          expect(binanceMock.client.exchangeInfo).not.toHaveBeenCalled();
        });

        it('does not trigger cache.hset for exchange info', () => {
          expect(cacheMock.hset).not.toHaveBeenCalledWith(
            'trailing-trade-common',
            'exchange-info',
            JSON.stringify(require('./fixtures/binance-exchange-info.json'))
          );
        });

        it('triggers cache.hset for exchange symbols', () => {
          expect(cacheMock.hset).toHaveBeenCalledWith(
            'trailing-trade-common',
            'exchange-symbols',
            JSON.stringify(
              require('./fixtures/binance-cached-exchange-symbols.json')
            )
          );
        });
      });

      describe('when cached exchange symbol is valid', () => {
        beforeEach(async () => {
          const { cache, binance, logger } = require('../../../helpers');

          cacheMock = cache;
          binanceMock = binance;

          cacheMock.hget = jest.fn().mockImplementation((hash, key) => {
            if (
              hash === 'trailing-trade-common' &&
              key === 'exchange-symbols'
            ) {
              return JSON.stringify(
                require('./fixtures/binance-cached-exchange-symbols.json')
              );
            }
            if (hash === 'trailing-trade-common' && key === 'exchange-info') {
              return JSON.stringify(
                require('./fixtures/binance-exchange-info.json')
              );
            }

            return null;
          });
          cacheMock.hset = jest.fn().mockResolvedValue(true);

          binanceMock.client.exchangeInfo = jest.fn().mockResolvedValue(null);

          commonHelper = require('../common');
          await commonHelper.cacheExchangeSymbols(logger, {
            supportFIATs: ['USDT', 'BUSD']
          });
        });

        it('triggers cache.hget for exchange symbols', () => {
          expect(cacheMock.hget).toHaveBeenCalledWith(
            'trailing-trade-common',
            'exchange-symbols'
          );
        });

        it('does not trigger cache.hget for exchange info', () => {
          expect(cacheMock.hget).not.toHaveBeenCalledWith(
            'trailing-trade-common',
            'exchange-info'
          );
        });

        it('does not trigger binance exchange info', () => {
          expect(binanceMock.client.exchangeInfo).not.toHaveBeenCalled();
        });

        it('does not trigger cache.hset for exchange info', () => {
          expect(cacheMock.hset).not.toHaveBeenCalledWith(
            'trailing-trade-common',
            'exchange-info',
            JSON.stringify(require('./fixtures/binance-exchange-info.json'))
          );
        });

        it('does not trigger cache.hset for exchange symbols', () => {
          expect(cacheMock.hset).not.toHaveBeenCalledWith(
            'trailing-trade-common',
            'exchange-symbols',
            JSON.stringify(
              require('./fixtures/binance-cached-exchange-symbols.json')
            )
          );
        });
      });
    });

    describe('when there is no cached exchange info but has cached exchange info', () => {
      beforeEach(async () => {
        const { cache, binance, logger } = require('../../../helpers');

        cacheMock = cache;
        binanceMock = binance;

        cacheMock.hget = jest.fn().mockImplementation((hash, key) => {
          if (hash === 'trailing-trade-common' && key === 'exchange-info') {
            return JSON.stringify(
              require('./fixtures/binance-exchange-info.json')
            );
          }

          return null;
        });

        cacheMock.hset = jest.fn().mockResolvedValue(true);

        binanceMock.client.exchangeInfo = jest
          .fn()
          .mockResolvedValue(require('./fixtures/binance-exchange-info.json'));

        commonHelper = require('../common');
        await commonHelper.cacheExchangeSymbols(logger, {
          supportFIATs: ['USDT', 'BUSD']
        });
      });

      it('triggers cache.hget for exchange symbols', () => {
        expect(cacheMock.hget).toHaveBeenCalledWith(
          'trailing-trade-common',
          'exchange-symbols'
        );
      });

      it('triggers cache.hget for exchange info', () => {
        expect(cacheMock.hget).toHaveBeenCalledWith(
          'trailing-trade-common',
          'exchange-info'
        );
      });

      it('does not trigger binance exchange info', () => {
        expect(binanceMock.client.exchangeInfo).not.toHaveBeenCalled();
      });

      it('does not triggers cache.hset for exchange info', () => {
        expect(cacheMock.hset).not.toHaveBeenCalledWith(
          'trailing-trade-common',
          'exchange-info',
          JSON.stringify(require('./fixtures/binance-exchange-info.json'))
        );
      });

      it('triggers cache.hset for exchange symbols', () => {
        expect(cacheMock.hset).toHaveBeenCalledWith(
          'trailing-trade-common',
          'exchange-symbols',
          JSON.stringify(
            require('./fixtures/binance-cached-exchange-symbols.json')
          )
        );
      });
    });
  });

  describe('extendBalancesWithDustTransfer', () => {
    beforeEach(async () => {
      const { cache, binance, logger } = require('../../../helpers');

      cacheMock = cache;
      binanceMock = binance;

      cacheMock.hset = jest.fn().mockResolvedValue(true);

      cacheMock.hget = jest.fn().mockImplementation((hash, key) => {
        if (
          hash === 'trailing-trade-symbols' &&
          key === 'ETHBTC-latest-candle'
        ) {
          return JSON.stringify({ close: '0.065840' });
        }

        if (
          hash === 'trailing-trade-symbols' &&
          key === 'LTCBTC-latest-candle'
        ) {
          return JSON.stringify({ close: '0.04480' });
        }

        if (
          hash === 'trailing-trade-symbols' &&
          key === 'TRXBTC-latest-candle'
        ) {
          return JSON.stringify({ close: '0.00000179' });
        }

        return null;
      });

      commonHelper = require('../common');
      result = await commonHelper.extendBalancesWithDustTransfer(logger, {
        balances: [
          {
            asset: 'BTC',
            free: '0.001'
          },
          {
            asset: 'BNB',
            free: '0.02'
          },
          {
            asset: 'ETH',
            free: '1'
          },
          {
            asset: 'LTC',
            free: '0.001'
          },
          {
            asset: 'TRX',
            free: '0.001'
          },
          {
            asset: 'XRP',
            free: '2'
          }
        ]
      });
    });

    it('returns expected result', () => {
      expect(result).toStrictEqual({
        balances: [
          {
            asset: 'BTC',
            canDustTransfer: false,
            estimatedBTC: -1,
            free: '0.001'
          },
          {
            asset: 'BNB',
            canDustTransfer: false,
            estimatedBTC: -1,
            free: '0.02'
          },
          {
            asset: 'ETH',
            canDustTransfer: false,
            estimatedBTC: '0.06584000',
            free: '1'
          },
          {
            asset: 'LTC',
            canDustTransfer: true,
            estimatedBTC: '0.00004480',
            free: '0.001'
          },
          {
            asset: 'TRX',
            canDustTransfer: true,
            estimatedBTC: '0.00000000',
            free: '0.001'
          },
          {
            asset: 'XRP',
            canDustTransfer: false,
            estimatedBTC: -1,
            free: '2'
          }
        ]
      });
    });
  });

  describe('getAccountInfoFromAPI', () => {
    beforeEach(async () => {
      const { cache, binance, logger } = require('../../../helpers');

      cacheMock = cache;
      binanceMock = binance;

      cacheMock.hset = jest.fn().mockResolvedValue(true);

      binanceMock.client.accountInfo = jest
        .fn()
        .mockResolvedValue(require('./fixtures/binance-account-info.json'));

      commonHelper = require('../common');
      result = await commonHelper.getAccountInfoFromAPI(logger);
    });

    it('triggers binance account info', () => {
      expect(binanceMock.client.accountInfo).toHaveBeenCalled();
    });

    it('triggers cache.hset', () => {
      expect(cacheMock.hset).toHaveBeenCalledWith(
        'trailing-trade-common',
        'account-info',
        JSON.stringify(require('./fixtures/binance-cached-account-info.json'))
      );
    });

    it('returns expected value', () => {
      expect(result).toStrictEqual(
        require('./fixtures/binance-cached-account-info.json')
      );
    });
  });

  describe('getAccountInfo', () => {
    describe('when there is cached account information', () => {
      beforeEach(async () => {
        const { cache, binance, logger } = require('../../../helpers');

        cacheMock = cache;
        binanceMock = binance;

        cacheMock.hgetWithoutLock = jest
          .fn()
          .mockResolvedValue(
            JSON.stringify(
              require('./fixtures/binance-cached-account-info.json')
            )
          );
        cacheMock.hset = jest.fn().mockResolvedValue(true);

        binanceMock.client.accountInfo = jest
          .fn()
          .mockResolvedValue(require('./fixtures/binance-account-info.json'));

        commonHelper = require('../common');
        result = await commonHelper.getAccountInfo(logger);
      });

      it('triggers cache.hgetWithoutLock for account info', () => {
        expect(cacheMock.hgetWithoutLock).toHaveBeenCalledWith(
          'trailing-trade-common',
          'account-info'
        );
      });

      it('does not trigger binance account info', () => {
        expect(binanceMock.client.accountInfo).not.toHaveBeenCalled();
      });

      it('does not trigger cache.hset', () => {
        expect(cacheMock.hset).not.toHaveBeenCalledWith(
          'trailing-trade-common',
          'account-info',
          JSON.stringify(require('./fixtures/binance-cached-account-info.json'))
        );
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual(
          require('./fixtures/binance-cached-account-info.json')
        );
      });
    });

    describe('when there is no cached account information', () => {
      beforeEach(async () => {
        const { cache, binance, logger } = require('../../../helpers');

        cacheMock = cache;
        binanceMock = binance;

        cacheMock.hgetWithoutLock = jest.fn().mockResolvedValue(null);
        cacheMock.hset = jest.fn().mockResolvedValue(true);

        binanceMock.client.accountInfo = jest
          .fn()
          .mockResolvedValue(require('./fixtures/binance-account-info.json'));

        commonHelper = require('../common');
        result = await commonHelper.getAccountInfo(logger);
      });

      it('triggers cache.hgetWithoutLock for account info', () => {
        expect(cacheMock.hgetWithoutLock).toHaveBeenCalledWith(
          'trailing-trade-common',
          'account-info'
        );
      });

      it('triggers binance account info', () => {
        expect(binanceMock.client.accountInfo).toHaveBeenCalled();
      });

      it('triggers cache.hset', () => {
        expect(cacheMock.hset).toHaveBeenCalledWith(
          'trailing-trade-common',
          'account-info',
          JSON.stringify(require('./fixtures/binance-cached-account-info.json'))
        );
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual(
          require('./fixtures/binance-cached-account-info.json')
        );
      });
    });
  });

  describe('getOpenOrdersFromAPI', () => {
    beforeEach(async () => {
      const { binance, logger } = require('../../../helpers');

      binanceMock = binance;

      binanceMock.client.openOrders = jest.fn().mockResolvedValue([
        {
          symbol: 'BTCUSDT'
        }
      ]);

      commonHelper = require('../common');
      result = await commonHelper.getOpenOrdersFromAPI(logger);
    });

    it('triggers binance.client.openOrders', () => {
      expect(binanceMock.client.openOrders).toHaveBeenCalledWith({
        recvWindow: 10000
      });
    });

    it('returns expected result', () => {
      expect(result).toStrictEqual([
        {
          symbol: 'BTCUSDT'
        }
      ]);
    });
  });

  describe('getOpenOrdersBySymbolFromAPI', () => {
    beforeEach(async () => {
      const { binance, logger } = require('../../../helpers');

      binanceMock = binance;
      binanceMock.client.openOrders = jest.fn().mockResolvedValue([
        {
          symbol: 'BTCUSDT'
        }
      ]);

      commonHelper = require('../common');
      result = await commonHelper.getOpenOrdersBySymbolFromAPI(
        logger,
        'BTCUSDT'
      );
    });

    it('triggers binance.client.openOrders', () => {
      expect(binanceMock.client.openOrders).toHaveBeenCalledWith({
        symbol: 'BTCUSDT',
        recvWindow: 10000
      });
    });

    it('returns expected result', () => {
      expect(result).toStrictEqual([{ symbol: 'BTCUSDT' }]);
    });
  });

  describe('getAndCacheOpenOrdersForSymbol', () => {
    beforeEach(async () => {
      const { binance, cache, logger } = require('../../../helpers');

      binanceMock = binance;
      binanceMock.client.openOrders = jest.fn().mockResolvedValue([
        {
          symbol: 'BTCUSDT'
        }
      ]);

      cacheMock = cache;
      loggerMock = logger;

      cacheMock.hset = jest.fn().mockResolvedValue(true);

      commonHelper = require('../common');
      result = await commonHelper.getAndCacheOpenOrdersForSymbol(
        logger,
        'BTCUSDT'
      );
    });

    it('triggers binance.client.openOrders', () => {
      expect(binanceMock.client.openOrders).toHaveBeenCalledWith({
        symbol: 'BTCUSDT',
        recvWindow: 10000
      });
    });

    it('triggers cache.hset', () => {
      expect(cacheMock.hset).toHaveBeenCalledWith(
        'trailing-trade-orders',
        'BTCUSDT',
        JSON.stringify([
          {
            symbol: 'BTCUSDT'
          }
        ])
      );
    });

    it('returns expected result', () => {
      expect(result).toStrictEqual([{ symbol: 'BTCUSDT' }]);
    });
  });

  describe('getLastBuyPrice', () => {
    describe('when nothing is returned', () => {
      beforeEach(async () => {
        const { mongo, logger } = require('../../../helpers');

        mongoMock = mongo;
        loggerMock = logger;

        mongoMock.findOne = jest.fn().mockResolvedValue(null);

        commonHelper = require('../common');
        result = await commonHelper.getLastBuyPrice(loggerMock, 'BTCUSDT');
      });

      it('triggers mongo.findOne', () => {
        expect(mongoMock.findOne).toHaveBeenCalledWith(
          loggerMock,
          'trailing-trade-symbols',
          {
            key: 'BTCUSDT-last-buy-price'
          }
        );
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual(null);
      });
    });

    describe('when returned last buy price', () => {
      beforeEach(async () => {
        const { mongo, logger } = require('../../../helpers');

        mongoMock = mongo;
        loggerMock = logger;

        mongoMock.findOne = jest.fn().mockResolvedValue({
          lastBuyPrice: 100,
          quantity: 10
        });

        commonHelper = require('../common');
        result = await commonHelper.getLastBuyPrice(loggerMock, 'BTCUSDT');
      });

      it('triggers mongo.findOne', () => {
        expect(mongoMock.findOne).toHaveBeenCalledWith(
          loggerMock,
          'trailing-trade-symbols',
          {
            key: 'BTCUSDT-last-buy-price'
          }
        );
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual({
          lastBuyPrice: 100,
          quantity: 10
        });
      });
    });
  });

  describe('saveLastBuyPrice', () => {
    beforeEach(async () => {
      const { mongo, logger } = require('../../../helpers');

      mongoMock = mongo;
      loggerMock = logger;

      mongoMock.upsertOne = jest.fn().mockResolvedValue(true);

      commonHelper = require('../common');
      result = await commonHelper.saveLastBuyPrice(loggerMock, 'BTCUSDT', {
        lastBuyPrice: 1000,
        quantity: 1
      });
    });

    it('triggers mongo.upsertOne', () => {
      expect(mongoMock.upsertOne).toHaveBeenCalledWith(
        loggerMock,
        'trailing-trade-symbols',
        { key: 'BTCUSDT-last-buy-price' },
        {
          key: 'BTCUSDT-last-buy-price',
          lastBuyPrice: 1000,
          quantity: 1
        }
      );
    });

    it('returns expected value', () => {
      expect(result).toBeTruthy();
    });
  });

  describe('lockSymbol', () => {
    describe('without ttl', () => {
      beforeEach(async () => {
        const { cache, logger } = require('../../../helpers');

        cacheMock = cache;
        loggerMock = logger;

        cacheMock.set = jest.fn().mockResolvedValue(true);

        commonHelper = require('../common');
        result = await commonHelper.lockSymbol(loggerMock, 'BTCUSDT');
      });

      it('triggers cache.set', () => {
        expect(cacheMock.set).toHaveBeenCalledWith('lock-BTCUSDT', true, 5);
      });

      it('returns expected value', () => {
        expect(result).toBeTruthy();
      });
    });

    describe('with ttl', () => {
      beforeEach(async () => {
        const { cache, logger } = require('../../../helpers');

        cacheMock = cache;
        loggerMock = logger;

        cacheMock.set = jest.fn().mockResolvedValue(true);

        commonHelper = require('../common');
        result = await commonHelper.lockSymbol(loggerMock, 'BTCUSDT', 10);
      });

      it('triggers cache.set', () => {
        expect(cacheMock.set).toHaveBeenCalledWith('lock-BTCUSDT', true, 10);
      });

      it('returns expected value', () => {
        expect(result).toBeTruthy();
      });
    });
  });

  describe('isSymbolLocked', () => {
    describe('cache exists', () => {
      beforeEach(async () => {
        const { cache, logger } = require('../../../helpers');

        cacheMock = cache;
        loggerMock = logger;

        cacheMock.get = jest.fn().mockResolvedValue('true');

        commonHelper = require('../common');
        result = await commonHelper.isSymbolLocked(loggerMock, 'BTCUSDT');
      });

      it('triggers cache.get', () => {
        expect(cacheMock.get).toHaveBeenCalledWith('lock-BTCUSDT');
      });

      it('returns expected value', () => {
        expect(result).toBeTruthy();
      });
    });

    describe('cache does not exist', () => {
      beforeEach(async () => {
        const { cache, logger } = require('../../../helpers');

        cacheMock = cache;
        loggerMock = logger;

        cacheMock.get = jest.fn().mockResolvedValue(null);

        commonHelper = require('../common');
        result = await commonHelper.isSymbolLocked(loggerMock, 'BTCUSDT');
      });

      it('triggers cache.get', () => {
        expect(cacheMock.get).toHaveBeenCalledWith('lock-BTCUSDT');
      });

      it('returns expected value', () => {
        expect(result).toBeFalsy();
      });
    });
  });

  describe('unlockSymbol', () => {
    beforeEach(async () => {
      const { cache, logger } = require('../../../helpers');

      cacheMock = cache;
      loggerMock = logger;

      cacheMock.del = jest.fn().mockResolvedValue(true);

      commonHelper = require('../common');
      result = await commonHelper.unlockSymbol(loggerMock, 'BTCUSDT');
    });

    it('triggers cache.del', () => {
      expect(cacheMock.del).toHaveBeenCalledWith('lock-BTCUSDT');
    });

    it('returns expected value', () => {
      expect(result).toBeTruthy();
    });
  });

  describe('disableAction', () => {
    beforeEach(async () => {
      const { cache } = require('../../../helpers');

      cacheMock = cache;

      cacheMock.set = jest.fn().mockResolvedValue(true);

      commonHelper = require('../common');
      result = await commonHelper.disableAction(
        'BTCUSDT',
        { some: 'reason' },
        60
      );
    });

    it('triggers cache.set', () => {
      expect(cacheMock.set).toHaveBeenCalledWith(
        'BTCUSDT-disable-action',
        JSON.stringify({ some: 'reason' }),
        60
      );
    });
  });

  describe('isActionDisabled', () => {
    describe('with enabled', () => {
      beforeEach(async () => {
        const { cache, logger } = require('../../../helpers');

        cacheMock = cache;
        loggerMock = logger;

        cacheMock.getWithTTL = jest.fn().mockResolvedValue([
          [null, -2],
          [null, null]
        ]);

        commonHelper = require('../common');
        result = await commonHelper.isActionDisabled('BTCUSDT');
      });

      it('triggers cache.getWithTTL', () => {
        expect(cacheMock.getWithTTL).toHaveBeenCalledWith(
          'BTCUSDT-disable-action'
        );
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual({
          isDisabled: false,
          ttl: -2
        });
      });
    });

    describe('with disabled', () => {
      beforeEach(async () => {
        const { cache, logger } = require('../../../helpers');

        cacheMock = cache;
        loggerMock = logger;

        cacheMock.getWithTTL = jest.fn().mockResolvedValue([
          [null, 300],
          [
            null,
            JSON.stringify({
              disabledBy: 'stop loss',
              message: 'Temporary disabled by stop loss',
              canResume: true,
              canRemoveLastBuyPrice: true
            })
          ]
        ]);

        commonHelper = require('../common');
        result = await commonHelper.isActionDisabled('BTCUSDT');
      });

      it('triggers cache.getWithTTL', () => {
        expect(cacheMock.getWithTTL).toHaveBeenCalledWith(
          'BTCUSDT-disable-action'
        );
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual({
          isDisabled: true,
          ttl: 300,
          disabledBy: 'stop loss',
          message: 'Temporary disabled by stop loss',
          canResume: true,
          canRemoveLastBuyPrice: true
        });
      });
    });
  });

  describe('deleteDisableAction', () => {
    beforeEach(async () => {
      const { cache, logger } = require('../../../helpers');

      cacheMock = cache;
      loggerMock = logger;

      cacheMock.del = jest.fn().mockResolvedValue(true);

      commonHelper = require('../common');
      result = await commonHelper.deleteDisableAction(loggerMock, 'BTCUSDT');
    });

    it('triggers cache.del', () => {
      expect(cacheMock.del).toHaveBeenCalledWith('BTCUSDT-disable-action');
    });

    it('returns expected value', () => {
      expect(result).toBeTruthy();
    });
  });

  describe('isExceedAPILimit', () => {
    describe('when getInfo returned undefined', () => {
      beforeEach(() => {
        const { binance, logger } = require('../../../helpers');

        loggerMock = logger;
        binanceMock = binance;

        binanceMock.client.getInfo = jest.fn().mockReturnValueOnce(undefined);

        result = commonHelper.isExceedAPILimit(loggerMock);
      });

      it('retruns expected value', () => {
        expect(result).toBeFalsy();
      });
    });

    describe('when getInfo returned without spot', () => {
      beforeEach(() => {
        const { binance, logger } = require('../../../helpers');

        loggerMock = logger;
        binanceMock = binance;

        binanceMock.client.getInfo = jest.fn().mockReturnValueOnce({
          futures: {}
        });

        result = commonHelper.isExceedAPILimit(loggerMock);
      });

      it('retruns expected value', () => {
        expect(result).toBeFalsy();
      });
    });

    describe('when getInfo returned with spot', () => {
      describe('less than 1180', () => {
        beforeEach(() => {
          const { binance, logger } = require('../../../helpers');

          loggerMock = logger;
          binanceMock = binance;

          binanceMock.client.getInfo = jest.fn().mockReturnValueOnce({
            spot: { usedWeight1m: '100' }
          });

          result = commonHelper.isExceedAPILimit(loggerMock);
        });

        it('retruns expected value', () => {
          expect(result).toBeFalsy();
        });
      });

      describe('more than 1180', () => {
        beforeEach(() => {
          const { binance, logger } = require('../../../helpers');

          loggerMock = logger;
          binanceMock = binance;

          binanceMock.client.getInfo = jest.fn().mockReturnValueOnce({
            spot: { usedWeight1m: '1180' }
          });

          result = commonHelper.isExceedAPILimit(loggerMock);
        });

        it('retruns expected value', () => {
          expect(result).toBeFalsy();
        });
      });
    });
  });

  describe('getOverrideDataForSymbol', () => {
    describe('when there is override data', () => {
      beforeEach(async () => {
        const { cache, logger } = require('../../../helpers');

        loggerMock = logger;
        cacheMock = cache;

        cacheMock.hget = jest.fn().mockResolvedValue(
          JSON.stringify({
            action: 'manual-trade',
            order: {
              some: 'value'
            }
          })
        );

        commonHelper = require('../common');

        result = await commonHelper.getOverrideDataForSymbol(
          loggerMock,
          'BTCUSDT'
        );
      });

      it('triggers cache.hget', () => {
        expect(cacheMock.hget).toHaveBeenCalledWith(
          'trailing-trade-override',
          'BTCUSDT'
        );
      });

      it('retruns expected value', () => {
        expect(result).toStrictEqual({
          action: 'manual-trade',
          order: {
            some: 'value'
          }
        });
      });
    });

    describe('when there is no override', () => {
      beforeEach(async () => {
        const { cache, logger } = require('../../../helpers');

        loggerMock = logger;
        cacheMock = cache;

        cacheMock.hget = jest.fn().mockResolvedValue(null);

        commonHelper = require('../common');
        result = await commonHelper.getOverrideDataForSymbol(
          loggerMock,
          'BTCUSDT'
        );
      });

      it('retruns expected value', () => {
        expect(result).toBeNull();
      });
    });
  });

  describe('removeOverrideDataForSymbol', () => {
    beforeEach(async () => {
      const { cache, logger } = require('../../../helpers');

      loggerMock = logger;
      cacheMock = cache;

      cacheMock.hdel = jest.fn().mockResolvedValue(true);

      commonHelper = require('../common');

      result = await commonHelper.removeOverrideDataForSymbol(
        loggerMock,
        'BTCUSDT'
      );
    });

    it('triggers cache.hdel', () => {
      expect(cacheMock.hdel).toHaveBeenCalledWith(
        'trailing-trade-override',
        'BTCUSDT'
      );
    });
  });

  describe('getOverrideDataForIndicator', () => {
    describe('when there is override data', () => {
      beforeEach(async () => {
        const { cache, logger } = require('../../../helpers');

        loggerMock = logger;
        cacheMock = cache;

        cacheMock.hget = jest.fn().mockResolvedValue(
          JSON.stringify({
            action: 'dust-transfer',
            order: {
              some: 'value'
            }
          })
        );

        commonHelper = require('../common');

        result = await commonHelper.getOverrideDataForIndicator(
          loggerMock,
          'global'
        );
      });

      it('triggers cache.hget', () => {
        expect(cacheMock.hget).toHaveBeenCalledWith(
          'trailing-trade-indicator-override',
          'global'
        );
      });

      it('retruns expected value', () => {
        expect(result).toStrictEqual({
          action: 'dust-transfer',
          order: {
            some: 'value'
          }
        });
      });
    });

    describe('when there is no override', () => {
      beforeEach(async () => {
        const { cache, logger } = require('../../../helpers');

        loggerMock = logger;
        cacheMock = cache;

        cacheMock.hget = jest.fn().mockResolvedValue(null);

        commonHelper = require('../common');
        result = await commonHelper.getOverrideDataForIndicator(
          loggerMock,
          'global'
        );
      });

      it('retruns expected value', () => {
        expect(result).toBeNull();
      });
    });
  });

  describe('removeOverrideDataForIndicator', () => {
    beforeEach(async () => {
      const { cache, logger } = require('../../../helpers');

      loggerMock = logger;
      cacheMock = cache;

      cacheMock.hdel = jest.fn().mockResolvedValue(true);

      commonHelper = require('../common');

      result = await commonHelper.removeOverrideDataForIndicator(
        loggerMock,
        'global'
      );
    });

    it('triggers cache.hdel', () => {
      expect(cacheMock.hdel).toHaveBeenCalledWith(
        'trailing-trade-indicator-override',
        'global'
      );
    });
  });
});
