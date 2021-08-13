const { cache, logger } = require('../../../../helpers');

const step = require('../save-data-to-cache');

describe('save-data-to-cache.js', () => {
  let rawData;

  describe('execute', () => {
    beforeEach(async () => {
      cache.hset = jest.fn().mockResolvedValue(true);

      rawData = {
        symbol: 'BTCUSDT',
        accountInfo: {
          my: 'account'
        },
        indicators: {
          some: 'value'
        },
        symbolInfo: {
          quoteAsset: 'USDT'
        },
        closedTrades: {
          quoteAsset: 'USDT',
          totalBuyQuoteQty: 10
        }
      };

      await step.execute(logger, rawData);
    });

    it('triggers cache.hset for symbol indicator data', () => {
      expect(cache.hset).toHaveBeenCalledWith(
        'trailing-trade-symbols',
        'BTCUSDT-indicator-data',
        JSON.stringify({
          some: 'value'
        })
      );
    });

    it('triggers cache.hset for trailing trade quote assets data', () => {
      expect(cache.hset).toHaveBeenCalledWith(
        'trailing-trade-closed-trades',
        'USDT',
        JSON.stringify({
          quoteAsset: 'USDT',
          totalBuyQuoteQty: 10
        })
      );
    });
  });
});
