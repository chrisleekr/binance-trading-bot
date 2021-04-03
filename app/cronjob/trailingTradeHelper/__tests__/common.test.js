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
      beforeEach(async () => {
        const { cache, binance, logger } = require('../../../helpers');

        cacheMock = cache;
        binanceMock = binance;

        cacheMock.hget = jest.fn().mockImplementation((hash, key) => {
          if (hash === 'trailing-trade-common' && key === 'exchange-symbols') {
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

      it('does not trigger cache.hset', () => {
        expect(cacheMock.hset).not.toHaveBeenCalled();
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

        cacheMock.hget = jest
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

      it('triggers cache.hget for account info', () => {
        expect(cacheMock.hget).toHaveBeenCalledWith(
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

        cacheMock.hget = jest.fn().mockResolvedValue(null);
        cacheMock.hset = jest.fn().mockResolvedValue(true);

        binanceMock.client.accountInfo = jest
          .fn()
          .mockResolvedValue(require('./fixtures/binance-account-info.json'));

        commonHelper = require('../common');
        result = await commonHelper.getAccountInfo(logger);
      });

      it('triggers cache.hget for account info', () => {
        expect(cacheMock.hget).toHaveBeenCalledWith(
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

  describe('getOpenOrdersFromCache', () => {
    describe('when there is cached open orders', () => {
      beforeEach(async () => {
        const { cache, logger } = require('../../../helpers');

        cacheMock = cache;

        cacheMock.hget = jest.fn().mockResolvedValue(
          JSON.stringify([
            {
              symbol: 'BTCUSDT'
            }
          ])
        );

        commonHelper = require('../common');
        result = await commonHelper.getOpenOrdersFromCache(logger);
      });

      it('triggers cache.hget for open orders', () => {
        expect(cacheMock.hget).toHaveBeenCalledWith(
          'trailing-trade-common',
          'open-orders'
        );
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual([
          {
            symbol: 'BTCUSDT'
          }
        ]);
      });
    });

    describe('when there is no cached open orders', () => {
      beforeEach(async () => {
        const { cache, logger } = require('../../../helpers');

        cacheMock = cache;

        cacheMock.hget = jest.fn().mockResolvedValue(null);

        commonHelper = require('../common');
        result = await commonHelper.getOpenOrdersFromCache(logger);
      });

      it('triggers cache.hget for open orders', () => {
        expect(cacheMock.hget).toHaveBeenCalledWith(
          'trailing-trade-common',
          'open-orders'
        );
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual([]);
      });
    });
  });

  describe('getOpenOrdersBySymbol', () => {
    beforeEach(async () => {
      const { binance, logger } = require('../../../helpers');

      binanceMock = binance;
      binanceMock.client.openOrders = jest.fn().mockResolvedValue([
        {
          symbol: 'BTCUSDT'
        }
      ]);

      commonHelper = require('../common');
      result = await commonHelper.getOpenOrdersBySymbol(logger, 'BTCUSDT');
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

  describe('refreshOpenOrdersWithSymbol', () => {
    describe('when cached open orders exists and has open orders from api', () => {
      beforeEach(async () => {
        const { cache, binance, logger } = require('../../../helpers');

        binanceMock = binance;
        cacheMock = cache;

        cacheMock.hget = jest.fn().mockResolvedValue(
          JSON.stringify([
            {
              orderId: 1,
              symbol: 'BTCUSDT'
            },
            {
              orderId: 2,
              symbol: 'BTCUSDT'
            },
            {
              orderId: 3,
              symbol: 'ETHUSDT'
            }
          ])
        );

        cacheMock.hset = jest.fn().mockResolvedValue(true);

        binanceMock.client.openOrders = jest.fn().mockResolvedValue([
          {
            orderId: 4,
            symbol: 'BTCUSDT'
          },
          {
            orderId: 5,
            symbol: 'BTCUSDT'
          }
        ]);

        commonHelper = require('../common');
        result = await commonHelper.refreshOpenOrdersWithSymbol(
          logger,
          'BTCUSDT'
        );
      });

      it('triggers cache.hget for open orders', () => {
        expect(cacheMock.hget).toHaveBeenCalledWith(
          'trailing-trade-common',
          'open-orders'
        );
      });

      it('triggers binance.client.openOrders', () => {
        expect(binanceMock.client.openOrders).toHaveBeenCalled();
      });

      it('triggers cache.hset with merged open orders', () => {
        expect(cacheMock.hset).toHaveBeenCalledWith(
          'trailing-trade-common',
          'open-orders',
          JSON.stringify([
            {
              orderId: 3,
              symbol: 'ETHUSDT'
            },
            {
              orderId: 4,
              symbol: 'BTCUSDT'
            },
            {
              orderId: 5,
              symbol: 'BTCUSDT'
            }
          ])
        );
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual([
          {
            orderId: 3,
            symbol: 'ETHUSDT'
          },
          {
            orderId: 4,
            symbol: 'BTCUSDT'
          },
          {
            orderId: 5,
            symbol: 'BTCUSDT'
          }
        ]);
      });
    });

    describe('when cached open orders does not exist', () => {
      beforeEach(async () => {
        const { cache, binance, logger } = require('../../../helpers');

        binanceMock = binance;
        cacheMock = cache;

        cacheMock.hget = jest.fn().mockResolvedValue(null);

        cacheMock.hset = jest.fn().mockResolvedValue(true);

        binanceMock.client.openOrders = jest.fn().mockResolvedValue([
          {
            orderId: 4,
            symbol: 'BTCUSDT'
          },
          {
            orderId: 5,
            symbol: 'BTCUSDT'
          }
        ]);

        commonHelper = require('../common');
        result = await commonHelper.refreshOpenOrdersWithSymbol(
          logger,
          'BTCUSDT'
        );
      });

      it('triggers cache.hget for open orders', () => {
        expect(cacheMock.hget).toHaveBeenCalledWith(
          'trailing-trade-common',
          'open-orders'
        );
      });

      it('triggers binance.client.openOrders', () => {
        expect(binanceMock.client.openOrders).toHaveBeenCalled();
      });

      it('triggers cache.hset with merged open orders', () => {
        expect(cacheMock.hset).toHaveBeenCalledWith(
          'trailing-trade-common',
          'open-orders',
          JSON.stringify([
            {
              orderId: 4,
              symbol: 'BTCUSDT'
            },
            {
              orderId: 5,
              symbol: 'BTCUSDT'
            }
          ])
        );
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual([
          {
            orderId: 4,
            symbol: 'BTCUSDT'
          },
          {
            orderId: 5,
            symbol: 'BTCUSDT'
          }
        ]);
      });
    });

    describe('when cached open orders exists but empty', () => {
      beforeEach(async () => {
        const { cache, binance, logger } = require('../../../helpers');

        binanceMock = binance;
        cacheMock = cache;

        cacheMock.hget = jest.fn().mockResolvedValue(JSON.stringify([]));

        cacheMock.hset = jest.fn().mockResolvedValue(true);

        binanceMock.client.openOrders = jest.fn().mockResolvedValue([
          {
            orderId: 4,
            symbol: 'BTCUSDT'
          },
          {
            orderId: 5,
            symbol: 'BTCUSDT'
          }
        ]);

        commonHelper = require('../common');
        result = await commonHelper.refreshOpenOrdersWithSymbol(
          logger,
          'BTCUSDT'
        );
      });

      it('triggers cache.hget for open orders', () => {
        expect(cacheMock.hget).toHaveBeenCalledWith(
          'trailing-trade-common',
          'open-orders'
        );
      });

      it('triggers binance.client.openOrders', () => {
        expect(binanceMock.client.openOrders).toHaveBeenCalled();
      });

      it('triggers cache.hset with merged open orders', () => {
        expect(cacheMock.hset).toHaveBeenCalledWith(
          'trailing-trade-common',
          'open-orders',
          JSON.stringify([
            {
              orderId: 4,
              symbol: 'BTCUSDT'
            },
            {
              orderId: 5,
              symbol: 'BTCUSDT'
            }
          ])
        );
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual([
          {
            orderId: 4,
            symbol: 'BTCUSDT'
          },
          {
            orderId: 5,
            symbol: 'BTCUSDT'
          }
        ]);
      });
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
          lastBuyPrice: 100
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
        expect(result).toStrictEqual(100);
      });
    });
  });
});
