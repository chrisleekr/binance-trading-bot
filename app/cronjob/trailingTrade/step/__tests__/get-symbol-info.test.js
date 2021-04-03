/* eslint-disable global-require */
const { binance, logger, cache } = require('../../../../helpers');

const step = require('../get-symbol-info');

describe('get-symbol-info.js', () => {
  let result;
  let rawData;

  describe('execute', () => {
    beforeEach(() => {
      cache.hget = jest.fn().mockResolvedValue(undefined);
      cache.hset = jest.fn().mockResolvedValue(true);
      binance.client.exchangeInfo = jest.fn().mockResolvedValue();
    });

    describe('when there is cached symbol info', () => {
      beforeEach(async () => {
        cache.hget = jest
          .fn()
          .mockResolvedValue(
            JSON.stringify(
              require('./fixtures/binance-cached-exchange-info.json')
            )
          );
        binance.client.exchangeInfo = jest.fn().mockResolvedValue();

        rawData = {
          symbol: 'BTCUSDT'
        };

        result = await step.execute(logger, rawData);
      });

      it('triggers cache.hget', () => {
        expect(cache.hget).toHaveBeenCalledWith(
          'trailing-trade-symbols',
          'BTCUSDT-symbol-info'
        );
      });

      it('does not trigger binance.client.exchangeInfo', () => {
        expect(binance.client.exchangeInfo).not.toHaveBeenCalled();
      });

      it('does not trigger cache.hset', () => {
        expect(cache.hset).not.toHaveBeenCalled();
      });

      it('returns expected data', () => {
        expect(result).toStrictEqual({
          symbol: 'BTCUSDT',
          symbolInfo: {
            baseAsset: 'BTC',
            baseAssetPrecision: 8,
            filterLotSize: {
              filterType: 'LOT_SIZE',
              maxQty: '900.00000000',
              minQty: '0.00000100',
              stepSize: '0.00000100'
            },
            filterMinNotional: {
              applyToMarket: true,
              avgPriceMins: 1,
              filterType: 'MIN_NOTIONAL',
              minNotional: '10.00000000'
            },
            filterPrice: {
              filterType: 'PRICE_FILTER',
              maxPrice: '1000000.00000000',
              minPrice: '0.01000000',
              tickSize: '0.01000000'
            },
            quoteAsset: 'USDT',
            quotePrecision: 8,
            status: 'TRADING',
            symbol: 'BTCUSDT'
          }
        });
      });
    });

    describe('when there is no cached symbol info, but has cached exchange info', () => {
      beforeEach(async () => {
        cache.hget = jest.fn().mockImplementation((hash, key) => {
          if (hash === 'trailing-trade-common' && key === 'exchange-info') {
            return JSON.stringify(
              require('./fixtures/binance-exchange-info.json')
            );
          }
          return null;
        });

        binance.client.exchangeInfo = jest
          .fn()
          .mockResolvedValue(require('./fixtures/binance-exchange-info.json'));

        rawData = {
          symbol: 'BTCUSDT'
        };

        result = await step.execute(logger, rawData);
      });

      it('triggers cache.hget', () => {
        expect(cache.hget).toHaveBeenCalledWith(
          'trailing-trade-symbols',
          'BTCUSDT-symbol-info'
        );
      });

      it('does not trigger binance.client.exchangeInfo', () => {
        expect(binance.client.exchangeInfo).not.toHaveBeenCalled();
      });

      it('triggers cache.hset', () => {
        expect(cache.hset).toHaveBeenCalledWith(
          'trailing-trade-symbols',
          'BTCUSDT-symbol-info',
          JSON.stringify(
            require('./fixtures/binance-cached-exchange-info.json')
          )
        );
      });

      it('returns expected data', () => {
        expect(result).toStrictEqual({
          symbol: 'BTCUSDT',
          symbolInfo: {
            baseAsset: 'BTC',
            baseAssetPrecision: 8,
            filterLotSize: {
              filterType: 'LOT_SIZE',
              maxQty: '900.00000000',
              minQty: '0.00000100',
              stepSize: '0.00000100'
            },
            filterMinNotional: {
              applyToMarket: true,
              avgPriceMins: 1,
              filterType: 'MIN_NOTIONAL',
              minNotional: '10.00000000'
            },
            filterPrice: {
              filterType: 'PRICE_FILTER',
              maxPrice: '1000000.00000000',
              minPrice: '0.01000000',
              tickSize: '0.01000000'
            },
            quoteAsset: 'USDT',
            quotePrecision: 8,
            status: 'TRADING',
            symbol: 'BTCUSDT'
          }
        });
      });
    });

    describe('when there is no cached symbol info, and no cached exchange info', () => {
      beforeEach(async () => {
        cache.hget = jest.fn().mockResolvedValue(null);

        binance.client.exchangeInfo = jest
          .fn()
          .mockResolvedValue(require('./fixtures/binance-exchange-info.json'));

        rawData = {
          symbol: 'BTCUSDT'
        };

        result = await step.execute(logger, rawData);
      });

      it('triggers cache.hget', () => {
        expect(cache.hget).toHaveBeenCalledWith(
          'trailing-trade-symbols',
          'BTCUSDT-symbol-info'
        );
      });

      it('triggers binance.client.exchangeInfo', () => {
        expect(binance.client.exchangeInfo).toHaveBeenCalled();
      });

      it('triggers cache.hset', () => {
        expect(cache.hset).toHaveBeenCalledWith(
          'trailing-trade-symbols',
          'BTCUSDT-symbol-info',
          JSON.stringify(
            require('./fixtures/binance-cached-exchange-info.json')
          )
        );
      });

      it('returns expected data', () => {
        expect(result).toStrictEqual({
          symbol: 'BTCUSDT',
          symbolInfo: {
            baseAsset: 'BTC',
            baseAssetPrecision: 8,
            filterLotSize: {
              filterType: 'LOT_SIZE',
              maxQty: '900.00000000',
              minQty: '0.00000100',
              stepSize: '0.00000100'
            },
            filterMinNotional: {
              applyToMarket: true,
              avgPriceMins: 1,
              filterType: 'MIN_NOTIONAL',
              minNotional: '10.00000000'
            },
            filterPrice: {
              filterType: 'PRICE_FILTER',
              maxPrice: '1000000.00000000',
              minPrice: '0.01000000',
              tickSize: '0.01000000'
            },
            quoteAsset: 'USDT',
            quotePrecision: 8,
            status: 'TRADING',
            symbol: 'BTCUSDT'
          }
        });
      });
    });
  });
});
