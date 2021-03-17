const { binance, logger } = require('../../../../helpers');

const step = require('../get-account-info');

describe('get-account-info.js', () => {
  let result;
  let rawData;

  describe('execute', () => {
    describe('when refresh account info indicator is false', () => {
      beforeEach(async () => {
        binance.client.accountInfo = jest.fn().mockResolvedValue();

        rawData = {
          symbolInfo: { baseAsset: 'BTC', quoteAsset: 'USDT' },
          buy: {},
          refreshAccountInfo: false,
          noChange: true
        };

        result = await step.execute(logger, rawData);
      });

      it('does not trigger binance.client.accountInfo', () => {
        expect(binance.client.accountInfo).not.toHaveBeenCalled();
      });

      it('return expected result', () => {
        expect(result).toStrictEqual({
          symbolInfo: { baseAsset: 'BTC', quoteAsset: 'USDT' },
          buy: {},
          refreshAccountInfo: false,
          noChange: true
        });
      });
    });

    describe('when refresh account info indicator is true', () => {
      describe('without buy current price', () => {
        beforeEach(async () => {
          binance.client.accountInfo = jest.fn().mockResolvedValue({
            updateTime: 1615880135619,
            balances: [
              { asset: 'BTC', free: '0.00100000', locked: '0.99900000' },
              { asset: 'ETH', free: '0.00000000', locked: '0.00000000' }
            ]
          });

          rawData = {
            symbolInfo: { baseAsset: 'BTC', quoteAsset: 'USDT' },
            buy: {},
            refreshAccountInfo: true
          };

          result = await step.execute(logger, rawData);
        });

        it('return expected result', () => {
          expect(result).toStrictEqual({
            symbolInfo: {
              baseAsset: 'BTC',
              quoteAsset: 'USDT'
            },
            accountInfo: {
              updateTime: 1615880135619,
              balances: [
                {
                  asset: 'BTC',
                  free: '0.00100000',
                  locked: '0.99900000',
                  total: 1,
                  updatedAt: expect.any(Object)
                }
              ]
            },
            baseAssetBalance: {
              asset: 'BTC',
              free: '0.00100000',
              locked: '0.99900000',
              total: 1,
              updatedAt: expect.any(Object)
            },
            buy: {},
            quoteAssetBalance: {
              asset: 'USDT',
              free: 0,
              locked: 0
            },
            refreshAccountInfo: false
          });
        });
      });

      describe('with buy current price', () => {
        beforeEach(async () => {
          binance.client.accountInfo = jest.fn().mockResolvedValue({
            updateTime: 1615880135619,
            balances: [
              { asset: 'BTC', free: '0.00100000', locked: '0.99900000' },
              { asset: 'ETH', free: '0.00000000', locked: '0.00000000' },
              { asset: 'USDT', free: '100.00000000', locked: '20.00000000' }
            ]
          });

          rawData = {
            symbolInfo: { baseAsset: 'BTC', quoteAsset: 'USDT' },
            buy: {
              currentPrice: 1000
            },
            refreshAccountInfo: true
          };

          result = await step.execute(logger, rawData);
        });

        it('return expected result', () => {
          expect(result).toStrictEqual({
            symbolInfo: {
              baseAsset: 'BTC',
              quoteAsset: 'USDT'
            },
            accountInfo: {
              updateTime: 1615880135619,
              balances: [
                {
                  asset: 'BTC',
                  free: '0.00100000',
                  locked: '0.99900000',
                  total: 1,
                  estimatedValue: 1000,
                  updatedAt: expect.any(Object)
                },
                { asset: 'USDT', free: '100.00000000', locked: '20.00000000' }
              ]
            },
            baseAssetBalance: {
              asset: 'BTC',
              free: '0.00100000',
              locked: '0.99900000',
              total: 1,
              estimatedValue: 1000,
              updatedAt: expect.any(Object)
            },
            buy: { currentPrice: 1000 },
            quoteAssetBalance: {
              asset: 'USDT',
              free: '100.00000000',
              locked: '20.00000000'
            },
            refreshAccountInfo: false
          });
        });
      });

      describe('when base/quote assets are not found', () => {
        beforeEach(async () => {
          binance.client.accountInfo = jest.fn().mockResolvedValue({
            updateTime: 1615880135619,
            balances: [
              { asset: 'BTC', free: '0.00100000', locked: '0.99900000' },
              { asset: 'ETH', free: '0.00000000', locked: '0.00000000' }
            ]
          });

          rawData = {
            symbolInfo: { baseAsset: 'BNB', quoteAsset: 'USDT' },
            buy: {
              currentPrice: 1000
            },
            refreshAccountInfo: true
          };

          result = await step.execute(logger, rawData);
        });

        it('return expected result', () => {
          expect(result).toStrictEqual({
            symbolInfo: {
              baseAsset: 'BNB',
              quoteAsset: 'USDT'
            },
            accountInfo: {
              updateTime: 1615880135619,
              balances: [
                { asset: 'BTC', free: '0.00100000', locked: '0.99900000' }
              ]
            },
            baseAssetBalance: {
              asset: 'BNB',
              free: 0,
              locked: 0,
              total: 0,
              estimatedValue: 0,
              updatedAt: expect.any(Object)
            },
            buy: { currentPrice: 1000 },
            quoteAssetBalance: {
              asset: 'USDT',
              free: 0,
              locked: 0
            },
            refreshAccountInfo: false
          });
        });
      });
    });
  });
});
