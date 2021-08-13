/* eslint-disable global-require */
const moment = require('moment-timezone');

describe('get-closed-trades.js', () => {
  let result;
  let rawData;

  let loggerMock;
  let mongoMock;
  let cacheMock;

  describe('execute', () => {
    beforeEach(() => {
      jest.clearAllMocks().resetModules();
    });

    describe('when mongo.aggregate returns value', () => {
      [
        {
          selectedPeriod: undefined
        },
        {
          selectedPeriod: 'd'
        },
        {
          selectedPeriod: 'w'
        },
        {
          selectedPeriod: 'm'
        },
        {
          selectedPeriod: 'a'
        }
      ].forEach(t => {
        describe(`selectedPeriod: ${t.selectedPeriod}`, () => {
          let start;
          let end;
          const match = {};

          beforeEach(async () => {
            const { cache, mongo, logger } = require('../../../../helpers');

            loggerMock = logger;
            cacheMock = cache;
            mongoMock = mongo;

            cacheMock.hget = jest.fn().mockResolvedValue(
              JSON.stringify({
                selectedPeriod: t.selectedPeriod
              })
            );

            cacheMock.hset = jest.fn().mockResolvedValue(true);

            start = null;
            end = null;

            switch (t.selectedPeriod) {
              case 'd':
                start = moment().startOf('day').toISOString();
                end = moment().endOf('day').toISOString();
                break;
              case 'w':
                start = moment().startOf('week').toISOString();
                end = moment().endOf('week').toISOString();
                break;
              case 'm':
                start = moment().startOf('month').toISOString();
                end = moment().endOf('month').toISOString();
                break;
              case 'a':
              default:
            }

            if (start || end) {
              match.archivedAt = {
                ...(start ? { $gte: moment(start).toISOString() } : {}),
                ...(end ? { $lte: moment(end).toISOString() } : {})
              };
            }

            mongoMock.aggregate = jest.fn().mockResolvedValue([
              {
                quoteAsset: 'USDT',
                totalBuyQuoteQty: 10,
                totalSellQuoteQty: 20,
                buyGridTradeQuoteQty: 30,
                buyManualQuoteQty: 40,
                sellGridTradeQuoteQty: 50,
                sellManualQuoteQty: 60,
                stopLossQuoteQty: 70,
                profit: 80,
                profitPercentage: 90,
                trades: 100
              }
            ]);

            rawData = {
              symbolInfo: {
                quoteAsset: 'USDT'
              },
              closedTrades: {}
            };

            const step = require('../get-closed-trades');
            result = await step.execute(loggerMock, rawData);
          });

          it('triggers cache.hget', () => {
            expect(cacheMock.hget).toHaveBeenCalledWith(
              'trailing-trade-common',
              'closed-trades'
            );
          });

          it('triggers mongo.aggregate', () => {
            expect(mongoMock.aggregate).toHaveBeenCalledWith(
              loggerMock,
              'trailing-trade-grid-trade-archive',
              [
                {
                  $match: { quoteAsset: 'USDT', ...match }
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

          it('triggers cache.hset', () => {
            expect(cacheMock.hset).toHaveBeenCalledWith(
              'trailing-trade-common',
              'closed-trades',
              JSON.stringify({
                selectedPeriod: t.selectedPeriod,
                loadedPeriod: t.selectedPeriod || 'a'
              })
            );
          });

          it('retruns expected result', () => {
            expect(result).toStrictEqual({
              symbolInfo: {
                quoteAsset: 'USDT'
              },
              closedTrades: {
                quoteAsset: 'USDT',
                totalBuyQuoteQty: 10,
                totalSellQuoteQty: 20,
                buyGridTradeQuoteQty: 30,
                buyManualQuoteQty: 40,
                sellGridTradeQuoteQty: 50,
                sellManualQuoteQty: 60,
                stopLossQuoteQty: 70,
                profit: 80,
                profitPercentage: 90,
                trades: 100
              }
            });
          });
        });
      });
    });

    describe('when mongo.aggregate does not return value', () => {
      beforeEach(async () => {
        const { cache, mongo, logger } = require('../../../../helpers');

        cacheMock = cache;
        loggerMock = logger;
        mongoMock = mongo;

        cacheMock.hget = jest.fn().mockResolvedValue(null);
        cacheMock.hset = jest.fn().mockResolvedValue(true);

        mongoMock.aggregate = jest.fn().mockResolvedValue([]);

        rawData = {
          symbolInfo: {
            quoteAsset: 'USDT'
          },
          closedTrades: {}
        };

        const step = require('../get-closed-trades');
        result = await step.execute(loggerMock, rawData);
      });

      it('triggers cache.hget', () => {
        expect(cacheMock.hget).toHaveBeenCalledWith(
          'trailing-trade-common',
          'closed-trades'
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

      it('triggers cache.hset', () => {
        expect(cacheMock.hset).toHaveBeenCalledWith(
          'trailing-trade-common',
          'closed-trades',
          JSON.stringify({
            loadedPeriod: 'a'
          })
        );
      });

      it('retruns expected result', () => {
        expect(result).toStrictEqual({
          symbolInfo: {
            quoteAsset: 'USDT'
          },
          closedTrades: {
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
        });
      });
    });
  });
});
