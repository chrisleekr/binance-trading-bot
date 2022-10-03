/* eslint-disable global-require */
describe('webserver/handlers/symbol-delete', () => {
  let loggerMock;
  let mongoMock;
  let cacheMock;
  let PubSubMock;

  let resSendMock;

  const appMock = {
    route: null
  };

  let deleteReq;

  let mockVerifyAuthenticated;
  let mockRemoveOverrideDataForSymbol;

  beforeEach(async () => {
    jest.clearAllMocks().resetModules();

    resSendMock = jest.fn().mockResolvedValue(true);
    appMock.route = jest.fn(() => ({
      delete: jest.fn().mockImplementation(func => {
        func(deleteReq, { send: resSendMock });
      })
    }));
  });

  describe('when verification failed', () => {
    beforeEach(async () => {
      const { logger, mongo } = require('../../../../helpers');

      loggerMock = logger;
      mongoMock = mongo;

      mockVerifyAuthenticated = jest.fn().mockResolvedValue(false);

      jest.mock('../../../../cronjob/trailingTradeHelper/common', () => ({
        verifyAuthenticated: mockVerifyAuthenticated
      }));

      deleteReq = {
        params: {
          symbol: 'BTCUSDT'
        },
        body: {
          authToken: 'some token'
        }
      };
      const { handleSymbolDelete } = require('../symbol-delete');

      await handleSymbolDelete(loggerMock, appMock);
    });

    it('triggers verifyAuthenticated', () => {
      expect(mockVerifyAuthenticated).toHaveBeenCalledWith(
        loggerMock,
        'some token'
      );
    });

    it('return unauthorised', () => {
      expect(resSendMock).toHaveBeenCalledWith({
        success: false,
        status: 403,
        message: 'Please authenticate first.',
        data: {
          rows: [],
          stats: {}
        }
      });
    });
  });

  describe('when verification success', () => {
    beforeEach(async () => {
      const { logger, cache, mongo, PubSub } = require('../../../../helpers');

      loggerMock = logger;
      mongoMock = mongo;
      cacheMock = cache;
      PubSubMock = PubSub;

      PubSubMock.publish = jest.fn().mockResolvedValue(true);

      mockVerifyAuthenticated = jest.fn().mockResolvedValue(true);
      mockRemoveOverrideDataForSymbol = jest.fn().mockResolvedValue(true);

      jest.mock('../../../../cronjob/trailingTradeHelper/common', () => ({
        verifyAuthenticated: mockVerifyAuthenticated,
        removeOverrideDataForSymbol: mockRemoveOverrideDataForSymbol
      }));

      mongoMock.deleteOne = jest.fn().mockResolvedValue(true);

      cacheMock.hgetall = jest.fn().mockResolvedValueOnce({
        'BTCUSDT-latest-candle': 'value1',
        'BTCUSDT-symbol-info': 'value2'
      });

      cacheMock.hdel = jest.fn().mockResolvedValue(true);

      PubSubMock.publish = jest.fn().mockResolvedValue(true);

      deleteReq = {
        params: {
          symbol: 'BTCUSDT'
        },
        body: {
          authToken: 'some token'
        }
      };
      const { handleSymbolDelete } = require('../symbol-delete');

      await handleSymbolDelete(loggerMock, appMock);
    });

    it('triggers verifyAuthenticated', () => {
      expect(mockVerifyAuthenticated).toHaveBeenCalledWith(
        loggerMock,
        'some token'
      );
    });

    it('triggers cache.hgetall for trailing-trade-symbols', () => {
      expect(cacheMock.hgetall).toHaveBeenCalledWith(
        'trailing-trade-symbols:',
        `trailing-trade-symbols:BTCUSDT*`
      );
    });

    ['BTCUSDT-latest-candle', 'BTCUSDT-symbol-info'].forEach(key => {
      it('triggers cache.hdel for trailing-trade-symbols', () => {
        expect(cacheMock.hdel).toHaveBeenCalledWith(
          'trailing-trade-symbols',
          key
        );
      });
    });

    it('triggers cache.del for trailing-trade-tradingview', () => {
      expect(cacheMock.hdel).toHaveBeenCalledWith(
        'trailing-trade-tradingview',
        'BTCUSDT'
      );
    });

    it('triggers mongo.deleteOne for last buy price', () => {
      expect(mongoMock.deleteOne).toHaveBeenCalledWith(
        loggerMock,
        'trailing-trade-symbols',
        {
          key: 'BTCUSDT-last-buy-price'
        }
      );
    });

    it('triggers mongo.deleteOne for trade cache', () => {
      expect(mongoMock.deleteOne).toHaveBeenCalledWith(
        loggerMock,
        'trailing-trade-cache',
        {
          symbol: 'BTCUSDT'
        }
      );
    });

    it('triggers removeOverrideDataForSymbol', () => {
      expect(mockRemoveOverrideDataForSymbol).toHaveBeenCalledWith(
        loggerMock,
        'BTCUSDT'
      );
    });

    it('triggers PubSub.publish', () => {
      expect(PubSubMock.publish).toHaveBeenCalledWith('frontend-notification', {
        type: 'info',
        title: 'BTCUSDT cache has been deleted successfully.'
      });
    });

    it('return data', () => {
      expect(resSendMock).toHaveBeenCalledWith({
        success: true,
        status: 200,
        message: 'Executed symbol-delete',
        data: {
          result: true
        }
      });
    });
  });
});
