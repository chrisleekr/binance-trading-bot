/* eslint-disable global-require */
describe('webserver/handlers/grid-trade-archive-delete', () => {
  let loggerMock;
  let mongoMock;

  let resSendMock;

  const appMock = {
    route: null
  };

  let postReq;

  let mockVerifyAuthenticated;

  beforeEach(async () => {
    jest.clearAllMocks().resetModules();

    resSendMock = jest.fn().mockResolvedValue(true);
    appMock.route = jest.fn(() => ({
      post: jest.fn().mockImplementation(func => {
        func(postReq, { send: resSendMock });
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

      postReq = {
        body: {
          authToken: 'some token',
          query: {
            key: 'BTCUSDT'
          }
        }
      };
      const {
        handleGridTradeArchiveDelete
      } = require('../grid-trade-archive-delete');

      await handleGridTradeArchiveDelete(loggerMock, appMock);
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
      const { logger, mongo } = require('../../../../helpers');

      loggerMock = logger;
      mongoMock = mongo;

      mockVerifyAuthenticated = jest.fn().mockResolvedValue(true);

      jest.mock('../../../../cronjob/trailingTradeHelper/common', () => ({
        verifyAuthenticated: mockVerifyAuthenticated
      }));

      mongoMock.deleteAll = jest.fn().mockResolvedValue(true);

      postReq = {
        body: {
          authToken: 'some token',
          query: {
            key: 'BTCUSDT'
          }
        }
      };
      const {
        handleGridTradeArchiveDelete
      } = require('../grid-trade-archive-delete');

      await handleGridTradeArchiveDelete(loggerMock, appMock);
    });

    it('triggers mongo.deleteAll', () => {
      expect(mongoMock.deleteAll).toHaveBeenCalledWith(
        loggerMock,
        'trailing-trade-grid-trade-archive',
        {
          key: 'BTCUSDT'
        }
      );
    });

    it('return unauthorised', () => {
      expect(resSendMock).toHaveBeenCalledWith({
        success: true,
        status: 200,
        message: 'Retrieved grid-trade-archive-delete',
        data: {}
      });
    });
  });
});
