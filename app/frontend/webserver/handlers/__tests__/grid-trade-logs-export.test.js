/* eslint-disable global-require */
describe('webserver/handlers/grid-trade-logs-export', () => {
  let loggerMock;
  let mongoMock;

  let rsDownload;
  let rsSend;

  const appMock = {
    route: null
  };

  let postReq;

  let mockVerifyAuthenticated;

  beforeEach(async () => {
    jest.clearAllMocks().resetModules();

    rsSend = jest.fn().mockResolvedValue(true);
    rsDownload = jest.fn().mockResolvedValue(true);
    appMock.route = jest.fn(() => ({
      post: jest.fn().mockImplementation(func => {
        func(postReq, { send: rsSend, download: rsDownload });
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
          symbol: 'BTCUSDT'
        }
      };
      const {
        handleGridTradeLogsExport
      } = require('../grid-trade-logs-export');

      await handleGridTradeLogsExport(loggerMock, appMock);
    });

    it('triggers verifyAuthenticated', () => {
      expect(mockVerifyAuthenticated).toHaveBeenCalledWith(
        loggerMock,
        'some token'
      );
    });

    it('return unauthorised', () => {
      expect(rsSend).toHaveBeenCalledWith({
        success: false,
        status: 403,
        message: 'Please authenticate first.',
        data: {
          rows: []
        }
      });
    });
  });

  describe('when verification success', () => {
    [
      {
        desc: 'symbol',
        requestBody: {
          authToken: 'valid-auth-token',
          symbol: 'BTCUSDT'
        },
        expectedMatch: {
          symbol: 'BTCUSDT'
        },
        expectFindAllParams: {
          sort: { loggedAt: -1 }
        }
      }
    ].forEach(t => {
      describe(`found rows - ${t.desc}`, () => {
        beforeEach(async () => {
          const { logger, mongo } = require('../../../../helpers');

          loggerMock = logger;
          mongoMock = mongo;

          mockVerifyAuthenticated = jest.fn().mockResolvedValue(true);

          jest.mock('../../../../cronjob/trailingTradeHelper/common', () => ({
            verifyAuthenticated: mockVerifyAuthenticated
          }));

          mongoMock.findAll = jest.fn().mockResolvedValue([
            {
              someValue: 'value1'
            },
            {
              someValue: 'value2'
            }
          ]);

          postReq = {
            body: t.requestBody
          };
          const {
            handleGridTradeLogsExport
          } = require('../grid-trade-logs-export');

          await handleGridTradeLogsExport(loggerMock, appMock);
        });

        it('triggers mongo.findAll', () => {
          expect(mongoMock.findAll).toHaveBeenCalledWith(
            loggerMock,
            'trailing-trade-logs',
            t.expectedMatch,
            t.expectFindAllParams
          );
        });

        it('return data', () => {
          expect(rsDownload).toHaveBeenCalledWith(
            expect.stringMatching('/tmp/(.+).json')
          );
        });
      });
    });

    describe(`cannot find rows`, () => {
      beforeEach(async () => {
        const { logger, mongo } = require('../../../../helpers');

        loggerMock = logger;
        mongoMock = mongo;

        mockVerifyAuthenticated = jest.fn().mockResolvedValue(true);

        jest.mock('../../../../cronjob/trailingTradeHelper/common', () => ({
          verifyAuthenticated: mockVerifyAuthenticated
        }));

        mongoMock.findAll = jest.fn().mockResolvedValue([]);

        mongoMock.aggregate = jest.fn().mockResolvedValue([]);

        postReq = {
          body: {
            authToken: 'valid-auth-token',
            symbol: 'BTCUSDT'
          }
        };
        const {
          handleGridTradeLogsExport
        } = require('../grid-trade-logs-export');

        await handleGridTradeLogsExport(loggerMock, appMock);
      });

      it('triggers mongo.findAll', () => {
        expect(mongoMock.findAll).toHaveBeenCalledWith(
          loggerMock,
          'trailing-trade-logs',
          {
            symbol: 'BTCUSDT'
          },
          {
            sort: { loggedAt: -1 }
          }
        );
      });

      it('return data', () => {
        expect(rsDownload).toHaveBeenCalledWith(
          expect.stringMatching('/tmp/(.+).json')
        );
      });
    });
  });
});
