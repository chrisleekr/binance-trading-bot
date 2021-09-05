/* eslint-disable global-require */
describe('webserver/handlers/closed-trades-set-period', () => {
  let loggerMock;
  let cacheMock;

  let resSendMock;

  const appMock = {
    route: null
  };

  let postReq;

  beforeEach(async () => {
    jest.clearAllMocks().resetModules();

    resSendMock = jest.fn().mockResolvedValue(true);
    appMock.route = jest.fn(() => ({
      post: jest.fn().mockImplementation(func => {
        func(postReq, { send: resSendMock });
      })
    }));
  });

  describe('when cache is not found', () => {
    beforeEach(async () => {
      const { cache, logger } = require('../../../../helpers');

      cacheMock = cache;
      loggerMock = logger;

      cacheMock.hget = jest.fn().mockResolvedValue(null);

      cacheMock.hset = jest.fn().mockResolvedValue(true);

      cacheMock.hdelall = jest.fn().mockResolvedValue(true);

      postReq = {
        body: {
          authToken: 'some token',
          selectedPeriod: 'd'
        }
      };
      const {
        handleClosedTradesSetPeriod
      } = require('../closed-trades-set-period');

      await handleClosedTradesSetPeriod(loggerMock, appMock);
    });

    it('triggers cache.hget', () => {
      expect(cacheMock.hget).toHaveBeenCalledWith(
        'trailing-trade-common',
        'closed-trades'
      );
    });

    it('triggers cache.hset', () => {
      expect(cacheMock.hset).toHaveBeenCalledWith(
        'trailing-trade-common',
        'closed-trades',
        JSON.stringify({
          selectedPeriod: 'd'
        })
      );
    });

    it('triggers cache.hdelall', () => {
      expect(cacheMock.hdelall).toHaveBeenCalledWith(
        'trailing-trade-closed-trades:*'
      );
    });

    it('return closed-trades-set-period', () => {
      expect(resSendMock).toHaveBeenCalledWith({
        success: true,
        status: 200,
        message: 'Set closed-trades-set-period',
        data: {}
      });
    });
  });

  describe('when cache is valid', () => {
    beforeEach(async () => {
      const { cache, logger } = require('../../../../helpers');

      cacheMock = cache;
      loggerMock = logger;

      cacheMock.hget = jest.fn().mockResolvedValue(
        JSON.stringify({
          loadedPeriod: 'a',
          selectedPeriod: 'a'
        })
      );

      cacheMock.hset = jest.fn().mockResolvedValue(true);
      cacheMock.hdelall = jest.fn().mockResolvedValue(true);

      postReq = {
        body: {
          authToken: 'some token',
          selectedPeriod: 'd'
        }
      };
      const {
        handleClosedTradesSetPeriod
      } = require('../closed-trades-set-period');

      await handleClosedTradesSetPeriod(loggerMock, appMock);
    });

    it('triggers cache.hget', () => {
      expect(cacheMock.hget).toHaveBeenCalledWith(
        'trailing-trade-common',
        'closed-trades'
      );
    });

    it('triggers cache.hset', () => {
      expect(cacheMock.hset).toHaveBeenCalledWith(
        'trailing-trade-common',
        'closed-trades',
        JSON.stringify({
          loadedPeriod: 'a',
          selectedPeriod: 'd'
        })
      );
    });

    it('triggers cache.hdelall', () => {
      expect(cacheMock.hdelall).toHaveBeenCalledWith(
        'trailing-trade-closed-trades:*'
      );
    });

    it('return closed-trades-set-period', () => {
      expect(resSendMock).toHaveBeenCalledWith({
        success: true,
        status: 200,
        message: 'Set closed-trades-set-period',
        data: {}
      });
    });
  });
});
