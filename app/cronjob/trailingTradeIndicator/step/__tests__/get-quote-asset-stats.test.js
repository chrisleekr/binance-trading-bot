/* eslint-disable global-require */
describe('get-quote-asset-stats.js', () => {
  let result;
  let rawData;

  let loggerMock;
  let mongoMock;

  describe('execute', () => {
    beforeEach(() => {
      jest.clearAllMocks().resetModules();
    });

    describe('when mongo.aggregate returns value', () => {
      beforeEach(async () => {
        const { mongo, logger } = require('../../../../helpers');

        loggerMock = logger;
        mongoMock = mongo;

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
          quoteAssetStats: {}
        };

        const step = require('../get-quote-asset-stats');
        result = await step.execute(loggerMock, rawData);
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

      it('retruns expected result', () => {
        expect(result).toStrictEqual({
          symbolInfo: {
            quoteAsset: 'USDT'
          },
          quoteAssetStats: {
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

    describe('when mongo.aggregate does not return value', () => {
      beforeEach(async () => {
        const { mongo, logger } = require('../../../../helpers');

        loggerMock = logger;
        mongoMock = mongo;

        mongoMock.aggregate = jest.fn().mockResolvedValue([]);

        rawData = {
          symbolInfo: {
            quoteAsset: 'USDT'
          },
          quoteAssetStats: {}
        };

        const step = require('../get-quote-asset-stats');
        result = await step.execute(loggerMock, rawData);
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

      it('retruns expected result', () => {
        expect(result).toStrictEqual({
          symbolInfo: {
            quoteAsset: 'USDT'
          },
          quoteAssetStats: {
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
