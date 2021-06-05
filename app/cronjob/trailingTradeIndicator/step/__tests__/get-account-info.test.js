/* eslint-disable global-require */

describe('get-account-info.js', () => {
  let loggerMock;
  let PubSubMock;
  let cacheMock;

  let rawData;

  let step;
  let result;

  let mockGetAccountInfoFromAPI;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();
  });

  describe('execute', () => {
    describe('when account info is cached and account assets are changed', () => {
      beforeEach(async () => {
        const { cache, PubSub, logger } = require('../../../../helpers');
        loggerMock = logger;
        cacheMock = cache;
        PubSubMock = PubSub;

        cacheMock.hget = jest.fn().mockImplementation((key, field) => {
          if (key === 'trailing-trade-common' && field === 'account-info') {
            return JSON.stringify({
              balances: [{ asset: 'BTC' }, { asset: 'BNB' }, { asset: 'LTC' }]
            });
          }

          return null;
        });
        cacheMock.hset = jest.fn().mockResolvedValue(true);
        PubSub.publish = jest.fn().mockResolvedValue(true);

        mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
          account: 'info',
          balances: [{ asset: 'BTC' }, { asset: 'XRP' }, { asset: 'ETH' }]
        });

        jest.mock('../../../trailingTradeHelper/common', () => ({
          getAccountInfoFromAPI: mockGetAccountInfoFromAPI
        }));

        step = require('../get-account-info');

        rawData = {
          some: 'value',
          globalConfiguration: { system: { refreshAccountInfoPeriod: 1 } }
        };
        result = await step.execute(loggerMock, rawData);
      });

      it('triggers cache.hget', () => {
        expect(cacheMock.hget).toHaveBeenCalledWith(
          'trailing-trade-common',
          'account-info'
        );
      });

      it('triggers cache.hset', () => {
        expect(cacheMock.hset).toHaveBeenCalledWith(
          'trailing-trade-common',
          'account-info',
          JSON.stringify({
            account: 'info',
            balances: [{ asset: 'BTC' }, { asset: 'XRP' }, { asset: 'ETH' }]
          })
        );
      });

      it('triggers PubSub.publish', () => {
        expect(PubSubMock.publish).toHaveBeenCalledWith(
          'reset-binance-websocket',
          true
        );
      });

      it('retruns expected data', () => {
        expect(result).toStrictEqual({
          some: 'value',
          globalConfiguration: { system: { refreshAccountInfoPeriod: 1 } },
          accountInfo: {
            account: 'info',
            balances: [{ asset: 'BTC' }, { asset: 'XRP' }, { asset: 'ETH' }]
          }
        });
      });
    });

    describe('when account info is cached and account assets are not changed', () => {
      beforeEach(async () => {
        const { cache, PubSub, logger } = require('../../../../helpers');
        loggerMock = logger;
        cacheMock = cache;
        PubSubMock = PubSub;

        cacheMock.hget = jest.fn().mockImplementation((key, field) => {
          if (key === 'trailing-trade-common' && field === 'account-info') {
            return JSON.stringify({
              balances: [{ asset: 'BTC' }, { asset: 'XRP' }, { asset: 'ETH' }]
            });
          }

          return null;
        });
        cacheMock.hset = jest.fn().mockResolvedValue(true);
        PubSub.publish = jest.fn().mockResolvedValue(true);

        mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
          account: 'info',
          balances: [{ asset: 'BTC' }, { asset: 'XRP' }, { asset: 'ETH' }]
        });

        jest.mock('../../../trailingTradeHelper/common', () => ({
          getAccountInfoFromAPI: mockGetAccountInfoFromAPI
        }));

        step = require('../get-account-info');

        rawData = {
          some: 'value',
          globalConfiguration: { system: { refreshAccountInfoPeriod: 1 } }
        };
        result = await step.execute(loggerMock, rawData);
      });

      it('triggers cache.hget', () => {
        expect(cacheMock.hget).toHaveBeenCalledWith(
          'trailing-trade-common',
          'account-info'
        );
      });

      it('triggers cache.hset', () => {
        expect(cacheMock.hset).toHaveBeenCalledWith(
          'trailing-trade-common',
          'account-info',
          JSON.stringify({
            account: 'info',
            balances: [{ asset: 'BTC' }, { asset: 'XRP' }, { asset: 'ETH' }]
          })
        );
      });

      it('does not trigger PubSub.publish', () => {
        expect(PubSubMock.publish).not.toHaveBeenCalled();
      });

      it('retruns expected data', () => {
        expect(result).toStrictEqual({
          some: 'value',
          globalConfiguration: { system: { refreshAccountInfoPeriod: 1 } },
          accountInfo: {
            account: 'info',
            balances: [{ asset: 'BTC' }, { asset: 'XRP' }, { asset: 'ETH' }]
          }
        });
      });
    });

    describe('when account info is not cached', () => {
      beforeEach(async () => {
        const { cache, PubSub, logger } = require('../../../../helpers');
        loggerMock = logger;
        cacheMock = cache;
        PubSubMock = PubSub;

        cacheMock.hget = jest.fn().mockImplementation((_key, _field) => null);
        cacheMock.hset = jest.fn().mockResolvedValue(true);
        PubSub.publish = jest.fn().mockResolvedValue(true);

        mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
          account: 'info',
          balances: [{ asset: 'BTC' }, { asset: 'XRP' }, { asset: 'ETH' }]
        });

        jest.mock('../../../trailingTradeHelper/common', () => ({
          getAccountInfoFromAPI: mockGetAccountInfoFromAPI
        }));

        step = require('../get-account-info');

        rawData = {
          some: 'value',
          globalConfiguration: { system: { refreshAccountInfoPeriod: 1 } }
        };
        result = await step.execute(loggerMock, rawData);
      });

      it('triggers cache.hget', () => {
        expect(cacheMock.hget).toHaveBeenCalledWith(
          'trailing-trade-common',
          'account-info'
        );
      });

      it('triggers cache.hset', () => {
        expect(cacheMock.hset).toHaveBeenCalledWith(
          'trailing-trade-common',
          'account-info',
          JSON.stringify({
            account: 'info',
            balances: [{ asset: 'BTC' }, { asset: 'XRP' }, { asset: 'ETH' }]
          })
        );
      });

      it('does not trigger PubSub.publish', () => {
        expect(PubSubMock.publish).not.toHaveBeenCalled();
      });

      it('retruns expected data', () => {
        expect(result).toStrictEqual({
          some: 'value',
          globalConfiguration: { system: { refreshAccountInfoPeriod: 1 } },
          accountInfo: {
            account: 'info',
            balances: [{ asset: 'BTC' }, { asset: 'XRP' }, { asset: 'ETH' }]
          }
        });
      });
    });

    describe('when refreshAccountInfoPeriod is 3', () => {
      describe('when current second is 31', () => {
        beforeEach(async () => {
          const { cache, PubSub, logger } = require('../../../../helpers');
          loggerMock = logger;
          cacheMock = cache;
          PubSubMock = PubSub;

          cacheMock.hget = jest.fn().mockImplementation((_key, _field) => null);
          cacheMock.hset = jest.fn().mockResolvedValue(true);
          PubSub.publish = jest.fn().mockResolvedValue(true);

          mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
            account: 'info',
            balances: [{ asset: 'BTC' }, { asset: 'XRP' }, { asset: 'ETH' }]
          });

          // Mock moment to return 31
          jest.mock(
            'moment',
            () => () => jest.requireActual('moment')('2020-01-01T00:00:31.000Z')
          );

          jest.mock('../../../trailingTradeHelper/common', () => ({
            getAccountInfoFromAPI: mockGetAccountInfoFromAPI
          }));

          step = require('../get-account-info');

          rawData = {
            some: 'value',
            globalConfiguration: { system: { refreshAccountInfoPeriod: 3 } }
          };
          result = await step.execute(loggerMock, rawData);
        });

        it('does not trigger cache.hget', () => {
          expect(cacheMock.hget).not.toHaveBeenCalled();
        });

        it('does not trigger cache.hset', () => {
          expect(cacheMock.hset).not.toHaveBeenCalled();
        });

        it('does not trigger PubSub.publish', () => {
          expect(PubSubMock.publish).not.toHaveBeenCalled();
        });

        it('retruns expected data', () => {
          expect(result).toStrictEqual({
            some: 'value',
            globalConfiguration: { system: { refreshAccountInfoPeriod: 3 } }
          });
        });
      });

      describe('when current second is 30', () => {
        beforeEach(async () => {
          const { cache, PubSub, logger } = require('../../../../helpers');
          loggerMock = logger;
          cacheMock = cache;
          PubSubMock = PubSub;

          cacheMock.hget = jest.fn().mockImplementation((_key, _field) => null);
          cacheMock.hset = jest.fn().mockResolvedValue(true);
          PubSub.publish = jest.fn().mockResolvedValue(true);

          mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
            account: 'info',
            balances: [{ asset: 'BTC' }, { asset: 'XRP' }, { asset: 'ETH' }]
          });

          // Mock moment to return 30
          jest.mock(
            'moment',
            () => () => jest.requireActual('moment')('2020-01-01T00:00:30.000Z')
          );

          jest.mock('../../../trailingTradeHelper/common', () => ({
            getAccountInfoFromAPI: mockGetAccountInfoFromAPI
          }));

          step = require('../get-account-info');

          rawData = {
            some: 'value',
            globalConfiguration: { system: { refreshAccountInfoPeriod: 3 } }
          };
          result = await step.execute(loggerMock, rawData);
        });

        it('triggers cache.hget', () => {
          expect(cacheMock.hget).toHaveBeenCalled();
        });

        it('triggers cache.hset', () => {
          expect(cacheMock.hset).toHaveBeenCalled();
        });

        it('does not triggers PubSub.publish', () => {
          expect(PubSubMock.publish).not.toHaveBeenCalled();
        });

        it('retruns expected data', () => {
          expect(result).toStrictEqual({
            some: 'value',
            globalConfiguration: { system: { refreshAccountInfoPeriod: 3 } },
            accountInfo: {
              account: 'info',
              balances: [{ asset: 'BTC' }, { asset: 'XRP' }, { asset: 'ETH' }]
            }
          });
        });
      });
    });
  });
});
