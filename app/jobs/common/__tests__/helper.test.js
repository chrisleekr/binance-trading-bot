/* eslint-disable global-require */
const { binance, logger, cache } = require('../../../helpers');

const commonHelper = require('../helper');

describe('commonHelper', () => {
  let result;

  describe('getSymbolInfo', () => {
    describe('when there is no cached symbol info', () => {
      beforeEach(async () => {
        cache.get = jest.fn().mockResolvedValue(undefined);
        cache.set = jest.fn().mockResolvedValue(true);

        result = await commonHelper.getSymbolInfo(logger, binance, 'BTCUSDT');
      });

      it('returns expected result', () => {
        expect(result.baseAsset).toEqual('BTC');
      });
    });

    describe('when there is cached symbol info', () => {});
  });

  describe('getOpenOrders', () => {
    beforeEach(async () => {
      result = await commonHelper.getOpenOrders(logger, binance, 'BTCUSDT');
    });

    it('returns expected result', () => {
      expect(result).toBeDefined();
    });
  });

  describe('getBalance', () => {
    describe('when side is buy', () => {
      beforeEach(async () => {
        const symbolInfo = await commonHelper.getSymbolInfo(logger, binance, 'BTCUSDT');
        result = await commonHelper.getBalance(logger, binance, symbolInfo, 'buy');
      });

      it('returns expected result', () => {
        expect(result.freeBalance).toBeDefined();
      });
    });
  });
});
