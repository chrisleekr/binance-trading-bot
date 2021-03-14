const { binance, cache, logger } = require('../../../../helpers');

const step = require('../get-exchange-symbols');

describe('get-exchange-symbols.js', () => {
  let result;
  let rawData;

  describe('execute', () => {
    describe('when cached exchange symbols is found', () => {
      beforeEach(async () => {
        cache.hget = jest.fn().mockResolvedValue({
          some: 'value'
        });
        rawData = {
          globalConfiguration: { supportFIATs: ['USDT'] }
        };

        result = await step.execute(logger, rawData);
      });

      it('triggers cache.hget', () => {
        expect(cache.hget).toHaveBeenCalledWith(
          'trailing-trade-common',
          'exchange-symbols'
        );
      });

      it('return expected result', () => {
        expect(result).toStrictEqual(rawData);
      });
    });

    describe('when there is no cached exchange symbols', () => {
      beforeEach(async () => {
        cache.hget = jest.fn().mockResolvedValue(undefined);
        cache.hset = jest.fn().mockResolvedValue(true);

        binance.client.exchangeInfo = jest.fn().mockResolvedValue({
          some: 'value',
          symbols: [
            {
              symbol: 'BNBBUSD'
            },
            {
              symbol: 'BNBUSDT'
            },
            {
              symbol: 'BTCUSDT'
            },
            {
              symbol: 'BNBUPUSDT'
            },
            {
              symbol: 'BTCBUSD'
            },
            {
              symbol: 'BTCAUD'
            }
          ]
        });

        rawData = {
          globalConfiguration: { supportFIATs: ['USDT'] }
        };

        result = await step.execute(logger, rawData);
      });

      it('triggers cache.hset', () => {
        expect(cache.hset).toHaveBeenCalledWith(
          'trailing-trade-common',
          'exchange-symbols',
          JSON.stringify(['BNBUSDT', 'BTCUSDT', 'BNBUPUSDT'])
        );
      });

      it('return expected result', () => {
        expect(result).toStrictEqual(rawData);
      });
    });
  });
});
