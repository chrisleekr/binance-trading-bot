/* eslint-disable global-require */
describe('webserver/handlers/grid-trade-logs-get', () => {
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
          type: 'quoteAsset',
          symbol: 'BTCUSDT',
          page: 1,
          limit: 5
        }
      };
      const { handleGridTradeLogsGet } = require('../grid-trade-logs-get');

      await handleGridTradeLogsGet(loggerMock, appMock);
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
    [
      {
        desc: 'symbol without page',
        requestBody: {
          authToken: 'valid-auth-token',
          symbol: 'BTCUSDT',
          limit: 10
        },
        expectedMatch: {
          symbol: 'BTCUSDT'
        },
        expectFindAllParams: {
          sort: { loggedAt: -1 },
          skip: 0,
          limit: 10
        },
        expectedGroup: {
          _id: '$symbol',
          symbol: { $first: '$symbol' }
        }
      },
      {
        desc: 'symbol without limit',
        requestBody: {
          authToken: 'valid-auth-token',
          symbol: 'BTCUSDT',
          page: 5
        },
        expectedMatch: {
          symbol: 'BTCUSDT'
        },
        expectFindAllParams: {
          sort: { loggedAt: -1 },
          skip: 20,
          limit: 5
        },
        expectedGroup: {
          _id: '$symbol',
          symbol: { $first: '$symbol' }
        }
      },
      {
        desc: 'symbol with page/limit',
        requestBody: {
          authToken: 'valid-auth-token',
          type: 'symbol',
          symbol: 'BTCUSDT',
          page: 5,
          limit: 5
        },
        expectedMatch: {
          symbol: 'BTCUSDT'
        },
        expectFindAllParams: {
          sort: { loggedAt: -1 },
          skip: 20,
          limit: 5
        },
        expectedGroup: {
          _id: '$symbol',
          symbol: { $first: '$symbol' }
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

          mongoMock.aggregate = jest.fn().mockResolvedValue([
            {
              rows: 2
            }
          ]);

          postReq = {
            body: t.requestBody
          };
          const { handleGridTradeLogsGet } = require('../grid-trade-logs-get');

          await handleGridTradeLogsGet(loggerMock, appMock);
        });

        it('triggers mongo.findAll', () => {
          expect(mongoMock.findAll).toHaveBeenCalledWith(
            loggerMock,
            'trailing-trade-logs',
            t.expectedMatch,
            t.expectFindAllParams
          );
        });

        it('triggers mongo.aggregate', () => {
          expect(mongoMock.aggregate).toHaveBeenCalledWith(
            loggerMock,
            'trailing-trade-logs',
            [
              {
                $match: { ...t.expectedMatch }
              },
              {
                $group: {
                  ...t.expectedGroup,
                  rows: { $sum: 1 }
                }
              },
              {
                $project: {
                  rows: 1
                }
              }
            ]
          );
        });

        it('return data', () => {
          expect(resSendMock).toHaveBeenCalledWith({
            success: true,
            status: 200,
            message: 'Retrieved grid-trade-logs-get',
            data: {
              rows: [
                {
                  someValue: 'value1'
                },
                {
                  someValue: 'value2'
                }
              ],
              stats: {
                rows: 2
              }
            }
          });
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
            symbol: 'BTCUSDT',
            page: 5
          }
        };
        const { handleGridTradeLogsGet } = require('../grid-trade-logs-get');

        await handleGridTradeLogsGet(loggerMock, appMock);
      });

      it('triggers mongo.findAll', () => {
        expect(mongoMock.findAll).toHaveBeenCalledWith(
          loggerMock,
          'trailing-trade-logs',
          {
            symbol: 'BTCUSDT'
          },
          {
            sort: { loggedAt: -1 },
            skip: 20,
            limit: 5
          }
        );
      });

      it('triggers mongo.aggregate', () => {
        expect(mongoMock.aggregate).toHaveBeenCalledWith(
          loggerMock,
          'trailing-trade-logs',
          [
            {
              $match: { symbol: 'BTCUSDT' }
            },
            {
              $group: {
                _id: '$symbol',
                symbol: { $first: '$symbol' },
                rows: { $sum: 1 }
              }
            },
            {
              $project: {
                rows: 1
              }
            }
          ]
        );
      });

      it('return data', () => {
        expect(resSendMock).toHaveBeenCalledWith({
          success: true,
          status: 200,
          message: 'Retrieved grid-trade-logs-get',
          data: {
            rows: [],
            stats: {
              symbol: 'BTCUSDT',
              rows: 0
            }
          }
        });
      });
    });
  });
});
