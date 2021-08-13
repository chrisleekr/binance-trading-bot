/* eslint-disable global-require */
describe('webserver/handlers/grid-trade-archive-get', () => {
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
          quoteAsset: 'USDT',
          page: 1,
          limit: 5
        }
      };
      const {
        handleGridTradeArchiveGet
      } = require('../grid-trade-archive-get');

      await handleGridTradeArchiveGet(loggerMock, appMock);
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
    describe('when type is not valid', () => {
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
            authToken: 'some token',
            type: 'invalid-type',
            page: 1,
            limit: 5
          }
        };
        const {
          handleGridTradeArchiveGet
        } = require('../grid-trade-archive-get');

        await handleGridTradeArchiveGet(loggerMock, appMock);
      });

      it('does not trigger mongo.findAll', () => {
        expect(mongoMock.findAll).not.toHaveBeenCalled();
      });

      it('does not trigger mongo.aggregate', () => {
        expect(mongoMock.aggregate).not.toHaveBeenCalled();
      });

      it('return unauthorised', () => {
        expect(resSendMock).toHaveBeenCalledWith({
          success: false,
          status: 400,
          message: `invalid-type is not allowed`,
          data: {
            rows: [],
            stats: {}
          }
        });
      });
    });

    [
      {
        desc: 'symbol type without page/start/end',
        requestBody: {
          authToken: 'valid-auth-token',
          type: 'symbol',
          symbol: 'BTCUSDT',
          limit: 10
        },
        expectedMatch: {
          symbol: 'BTCUSDT'
        },
        expectFindAllParams: {
          sort: { archivedAt: -1 },
          skip: 0,
          limit: 10
        },
        expectedGroup: {
          _id: '$symbol',
          symbol: { $first: '$symbol' }
        },
        expectedProject: {
          symbol: 1
        }
      },
      {
        desc: 'symbol type without limit/start/end',
        requestBody: {
          authToken: 'valid-auth-token',
          type: 'symbol',
          symbol: 'BTCUSDT',
          page: 5
        },
        expectedMatch: {
          symbol: 'BTCUSDT'
        },
        expectFindAllParams: {
          sort: { archivedAt: -1 },
          skip: 20,
          limit: 5
        },
        expectedGroup: {
          _id: '$symbol',
          symbol: { $first: '$symbol' }
        },
        expectedProject: {
          symbol: 1
        }
      },
      {
        desc: 'symbol type with start/end',
        requestBody: {
          authToken: 'valid-auth-token',
          type: 'symbol',
          symbol: 'BTCUSDT',
          page: 5,
          limit: 5,
          start: '2021-01-01T00:00:00+00:00',
          end: '2021-01-31T00:00:00+00:00'
        },
        expectedMatch: {
          symbol: 'BTCUSDT',
          archivedAt: {
            $gte: '2021-01-01T00:00:00.000Z',
            $lte: '2021-01-31T00:00:00.000Z'
          }
        },
        expectFindAllParams: {
          sort: { archivedAt: -1 },
          skip: 20,
          limit: 5
        },
        expectedGroup: {
          _id: '$symbol',
          symbol: { $first: '$symbol' }
        },
        expectedProject: {
          symbol: 1
        }
      },
      {
        desc: 'symbol type with start',
        requestBody: {
          authToken: 'valid-auth-token',
          type: 'symbol',
          symbol: 'BTCUSDT',
          page: 5,
          limit: 5,
          start: '2021-01-01T00:00:00+00:00'
        },
        expectedMatch: {
          symbol: 'BTCUSDT',
          archivedAt: {
            $gte: '2021-01-01T00:00:00.000Z'
          }
        },
        expectFindAllParams: {
          sort: { archivedAt: -1 },
          skip: 20,
          limit: 5
        },
        expectedGroup: {
          _id: '$symbol',
          symbol: { $first: '$symbol' }
        },
        expectedProject: {
          symbol: 1
        }
      },
      {
        desc: 'symbol type with end',
        requestBody: {
          authToken: 'valid-auth-token',
          type: 'symbol',
          symbol: 'BTCUSDT',
          page: 5,
          limit: 5,
          end: '2021-01-31T00:00:00+00:00'
        },
        expectedMatch: {
          symbol: 'BTCUSDT',
          archivedAt: {
            $lte: '2021-01-31T00:00:00.000Z'
          }
        },
        expectFindAllParams: {
          sort: { archivedAt: -1 },
          skip: 20,
          limit: 5
        },
        expectedGroup: {
          _id: '$symbol',
          symbol: { $first: '$symbol' }
        },
        expectedProject: {
          symbol: 1
        }
      },
      {
        desc: 'quoteAsset type with start/end',
        requestBody: {
          authToken: 'valid-auth-token',
          type: 'quoteAsset',
          quoteAsset: 'USDT',
          page: 5,
          limit: 5,
          start: '2021-01-01T00:00:00+00:00',
          end: '2021-01-31T00:00:00+00:00'
        },
        expectedMatch: {
          quoteAsset: 'USDT',
          archivedAt: {
            $gte: '2021-01-01T00:00:00.000Z',
            $lte: '2021-01-31T00:00:00.000Z'
          }
        },
        expectFindAllParams: {
          sort: { archivedAt: -1 },
          skip: 20,
          limit: 5
        },
        expectedGroup: {
          _id: '$quoteAsset',
          quoteAsset: { $first: '$quoteAsset' }
        },
        expectedProject: {
          quoteAsset: 1
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
              someValue: 'value',
              totalBuyQuoteQty: 10
            },
            {
              someValue: 'value',
              totalBuyQuoteQty: 10
            }
          ]);

          mongoMock.aggregate = jest.fn().mockResolvedValue([
            {
              someValue: 1,
              totalBuyQuoteQty: 20
            }
          ]);

          postReq = {
            body: t.requestBody
          };
          const {
            handleGridTradeArchiveGet
          } = require('../grid-trade-archive-get');

          await handleGridTradeArchiveGet(loggerMock, appMock);
        });

        it('triggers mongo.findAll', () => {
          expect(mongoMock.findAll).toHaveBeenCalledWith(
            loggerMock,
            'trailing-trade-grid-trade-archive',
            t.expectedMatch,
            t.expectFindAllParams
          );
        });

        it('triggers mongo.aggregate', () => {
          expect(mongoMock.aggregate).toHaveBeenCalledWith(
            loggerMock,
            'trailing-trade-grid-trade-archive',
            [
              {
                $match: { ...t.expectedMatch }
              },
              {
                $group: {
                  ...t.expectedGroup,
                  totalBuyQuoteQty: { $sum: '$totalBuyQuoteQty' },
                  totalSellQuoteQty: { $sum: '$totalSellQuoteQty' },
                  buyGridTradeQuoteQty: { $sum: '$buyGridTradeQuoteQty' },
                  buyManualQuoteQty: { $sum: '$buyManualQuoteQty' },
                  sellGridTradeQuoteQty: { $sum: '$sellGridTradeQuoteQty' },
                  sellManualQuoteQty: { $sum: '$sellManualQuoteQty' },
                  stopLossQuoteQty: { $sum: '$stopLossQuoteQty' },
                  profit: { $sum: '$profit' },
                  trades: { $sum: 1 }
                }
              },
              {
                $project: {
                  ...t.expectedProject,
                  totalBuyQuoteQty: 1,
                  totalSellQuoteQty: 1,
                  buyGridTradeQuoteQty: 1,
                  buyManualQuoteQty: 1,
                  sellGridTradeQuoteQty: 1,
                  sellManualQuoteQty: 1,
                  stopLossQuoteQty: 1,
                  profit: 1,
                  profitPercentage: {
                    $multiply: [
                      { $divide: ['$profit', '$totalBuyQuoteQty'] },
                      100
                    ]
                  },
                  trades: 1
                }
              }
            ]
          );
        });

        it('return unauthorised', () => {
          expect(resSendMock).toHaveBeenCalledWith({
            success: true,
            status: 200,
            message: 'Retrieved grid-trade-archive-get',
            data: {
              rows: [
                {
                  someValue: 'value',
                  totalBuyQuoteQty: 10
                },
                {
                  someValue: 'value',
                  totalBuyQuoteQty: 10
                }
              ],
              stats: {
                someValue: 1,
                totalBuyQuoteQty: 20
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
            type: 'quoteAsset',
            quoteAsset: 'USDT',
            page: 5
          }
        };
        const {
          handleGridTradeArchiveGet
        } = require('../grid-trade-archive-get');

        await handleGridTradeArchiveGet(loggerMock, appMock);
      });

      it('triggers mongo.findAll', () => {
        expect(mongoMock.findAll).toHaveBeenCalledWith(
          loggerMock,
          'trailing-trade-grid-trade-archive',
          {
            quoteAsset: 'USDT'
          },
          {
            sort: { archivedAt: -1 },
            skip: 20,
            limit: 5
          }
        );
      });

      it('triggers mongo.aggregate', () => {
        expect(mongoMock.aggregate).toHaveBeenCalledWith(
          loggerMock,
          'trailing-trade-grid-trade-archive',
          [
            {
              $match: { quoteAsset: 'USDT' }
            },
            {
              $group: {
                _id: '$quoteAsset',
                quoteAsset: { $first: '$quoteAsset' },
                totalBuyQuoteQty: { $sum: '$totalBuyQuoteQty' },
                totalSellQuoteQty: { $sum: '$totalSellQuoteQty' },
                buyGridTradeQuoteQty: { $sum: '$buyGridTradeQuoteQty' },
                buyManualQuoteQty: { $sum: '$buyManualQuoteQty' },
                sellGridTradeQuoteQty: { $sum: '$sellGridTradeQuoteQty' },
                sellManualQuoteQty: { $sum: '$sellManualQuoteQty' },
                stopLossQuoteQty: { $sum: '$stopLossQuoteQty' },
                profit: { $sum: '$profit' },
                trades: { $sum: 1 }
              }
            },
            {
              $project: {
                quoteAsset: 1,
                totalBuyQuoteQty: 1,
                totalSellQuoteQty: 1,
                buyGridTradeQuoteQty: 1,
                buyManualQuoteQty: 1,
                sellGridTradeQuoteQty: 1,
                sellManualQuoteQty: 1,
                stopLossQuoteQty: 1,
                profit: 1,
                profitPercentage: {
                  $multiply: [
                    { $divide: ['$profit', '$totalBuyQuoteQty'] },
                    100
                  ]
                },
                trades: 1
              }
            }
          ]
        );
      });

      it('return unauthorised', () => {
        expect(resSendMock).toHaveBeenCalledWith({
          success: true,
          status: 200,
          message: 'Retrieved grid-trade-archive-get',
          data: {
            rows: [],
            stats: {
              quoteAsset: 'USDT',
              totalBuyQuoteQty: 0,
              totalSellQuoteQty: 0,
              buyGridTradeQuoteQty: 0,
              buyManualQuoteQty: 0,
              sellGridTradeQuoteQty: 0,
              sellManualQuoteQty: 0,
              stopLossQuoteQty: 0,
              profit: 0,
              profitPercentage: 0,
              trades: 0
            }
          }
        });
      });
    });
  });
});
