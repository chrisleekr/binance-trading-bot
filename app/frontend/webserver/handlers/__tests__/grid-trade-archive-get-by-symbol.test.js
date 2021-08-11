/* eslint-disable global-require */
describe('webserver/handlers/grid-trade-archive-by-symbol', () => {
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
          symbol: 'BTCUSDT',
          page: 1,
          limit: 5
        }
      };
      const {
        handleGridTradeArchiveGetBySymbol
      } = require('../grid-trade-archive-get-by-symbol');

      await handleGridTradeArchiveGetBySymbol(loggerMock, appMock);
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
        page: 1,
        expectedSkip: 0
      },

      {
        page: 5,
        expectedSkip: 20
      }
    ].forEach(t => {
      describe(`found rows - page ${t.page}`, () => {
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
              symbol: 'BTCUSDT',
              totalBuyQuoteQty: 10
            },
            {
              symbol: 'BTCUSDT',
              totalBuyQuoteQty: 10
            }
          ]);

          mongoMock.aggregate = jest.fn().mockResolvedValue([
            {
              symbol: 1,
              totalBuyQuoteQty: 20
            }
          ]);

          postReq = {
            body: {
              authToken: 'some token',
              symbol: 'BTCUSDT',
              page: t.page,
              limit: 5
            }
          };
          const {
            handleGridTradeArchiveGetBySymbol
          } = require('../grid-trade-archive-get-by-symbol');

          await handleGridTradeArchiveGetBySymbol(loggerMock, appMock);
        });

        it('triggers mongo.findAll', () => {
          expect(mongoMock.findAll).toHaveBeenCalledWith(
            loggerMock,
            'trailing-trade-grid-trade-archive',
            {
              symbol: 'BTCUSDT'
            },
            {
              sort: { archivedAt: -1 },
              skip: t.expectedSkip,
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
                $match: { symbol: 'BTCUSDT' }
              },
              {
                $group: {
                  _id: '$symbol',
                  symbol: { $first: '$symbol' },
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
                  symbol: 1,
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
            message: 'Retrieved grid-trade-archive-by-symbol',
            data: {
              rows: [
                {
                  symbol: 'BTCUSDT',
                  totalBuyQuoteQty: 10
                },
                {
                  symbol: 'BTCUSDT',
                  totalBuyQuoteQty: 10
                }
              ],
              stats: {
                symbol: 1,
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
            authToken: 'some token',
            symbol: 'BTCUSDT',
            page: 1,
            limit: 5
          }
        };
        const {
          handleGridTradeArchiveGetBySymbol
        } = require('../grid-trade-archive-get-by-symbol');

        await handleGridTradeArchiveGetBySymbol(loggerMock, appMock);
      });

      it('triggers mongo.findAll', () => {
        expect(mongoMock.findAll).toHaveBeenCalledWith(
          loggerMock,
          'trailing-trade-grid-trade-archive',
          {
            symbol: 'BTCUSDT'
          },
          {
            sort: { archivedAt: -1 },
            skip: 0,
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
              $match: { symbol: 'BTCUSDT' }
            },
            {
              $group: {
                _id: '$symbol',
                symbol: { $first: '$symbol' },
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
                symbol: 1,
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
          message: 'Retrieved grid-trade-archive-by-symbol',
          data: {
            rows: [],
            stats: {
              symbol: 'BTCUSDT',
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
