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
          selectedPeriod: undefined,
          selectedPeriodTZ: 'UTC',
          selectedPeriodLC: 'us'
        },
        {
          selectedPeriod: 'd',
          selectedPeriodTZ: 'UTC',
          selectedPeriodLC: 'us'
        },
        {
          selectedPeriod: 'w',
          selectedPeriodTZ: 'UTC',
          selectedPeriodLC: 'us'
        },
        {
          selectedPeriod: 'm',
          selectedPeriodTZ: 'UTC',
          selectedPeriodLC: 'us'
        },
        {
          selectedPeriod: 'a',
          selectedPeriodTZ: 'UTC',
          selectedPeriodLC: 'us'
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
                selectedPeriod: t.selectedPeriod,
                selectedPeriodTZ: t.selectedPeriodTZ,
                selectedPeriodLC: t.selectedPeriodLC
              })
            );

            cacheMock.hset = jest.fn().mockResolvedValue(true);

            start = null;
            end = null;

            const momentLocale = moment
              .tz(t.selectedPeriodTZ)
              .locale(t.selectedPeriodLC);

            switch (t.selectedPeriod) {
              case 'd':
                start = momentLocale.startOf('day').toISOString();
                end = momentLocale.endOf('day').toISOString();
                break;
              case 'w':
                start = momentLocale.startOf('week').toISOString();
                end = momentLocale.endOf('week').toISOString();
                break;
              case 'm':
                start = momentLocale.startOf('month').toISOString();
                end = momentLocale.endOf('month').toISOString();
                break;
              case 'a':
              default:
            }

            if (start || end) {
              match.archivedAt = {
                ...(start ? { $gte: start } : {}),
                ...(end ? { $lte: end } : {})
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
                trades: 100,
                lastProfit: 110,
                lastSymbol: 'BTCUSDT',
                lastArchivedAt: '2022-08-17T21:04:47.017Z'
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
                    trades: { $sum: 1 },
                    lastProfit: { $last: '$profit' },
                    lastSymbol: { $last: '$symbol' },
                    lastArchivedAt: { $last: '$archivedAt' }
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
                      $cond: {
                        if: {
                          $gt: ['$totalBuyQuoteQty', 0]
                        },
                        then: {
                          $multiply: [
                            {
                              $divide: ['$profit', '$totalBuyQuoteQty']
                            },
                            100
                          ]
                        },
                        else: 0
                      }
                    },
                    trades: 1,
                    lastProfit: 1,
                    lastSymbol: 1,
                    lastArchivedAt: 1
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
                selectedPeriodTZ: t.selectedPeriodTZ,
                selectedPeriodLC: t.selectedPeriodLC,
                loadedPeriod: t.selectedPeriod || 'a',
                loadedPeriodTZ: t.selectedPeriodTZ,
                loadedPeriodLC: t.selectedPeriodLC
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
                trades: 100,
                lastProfit: 110,
                lastSymbol: 'BTCUSDT',
                lastArchivedAt: '2022-08-17T21:04:47.017Z'
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
                trades: { $sum: 1 },
                lastProfit: { $last: '$profit' },
                lastSymbol: { $last: '$symbol' },
                lastArchivedAt: { $last: '$archivedAt' }
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
                  $cond: {
                    if: {
                      $gt: ['$totalBuyQuoteQty', 0]
                    },
                    then: {
                      $multiply: [
                        {
                          $divide: ['$profit', '$totalBuyQuoteQty']
                        },
                        100
                      ]
                    },
                    else: 0
                  }
                },
                trades: 1,
                lastProfit: 1,
                lastSymbol: 1,
                lastArchivedAt: 1
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
            loadedPeriod: 'a',
            loadedPeriodTZ: 'UTC',
            loadedPeriodLC: 'us'
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
            trades: 0,
            lastProfit: 0,
            lastSymbol: '',
            lastArchivedAt: ''
          }
        });
      });
    });
  });
});
