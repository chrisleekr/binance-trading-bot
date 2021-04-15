/* eslint-disable global-require */
const { logger } = require('../../../../helpers');

const step = require('../get-balances');

describe('determine-action.js', () => {
  let result;
  let rawData;

  const accountInfoJSON = require('./fixtures/binance-account-info.json');

  describe('execute', () => {
    describe('when found base asset and quote asset', () => {
      describe('when current price is provided', () => {
        beforeEach(async () => {
          rawData = {
            accountInfo: accountInfoJSON,
            symbolInfo: {
              baseAsset: 'ETH',
              quoteAsset: 'USDT'
            },
            buy: {
              currentPrice: 1936
            }
          };

          result = await step.execute(logger, rawData);
        });

        it('retruns expected data', () => {
          expect(result).toStrictEqual({
            accountInfo: accountInfoJSON,
            symbolInfo: { baseAsset: 'ETH', quoteAsset: 'USDT' },
            buy: { currentPrice: 1936 },
            baseAssetBalance: {
              asset: 'ETH',
              free: '0.10050000',
              locked: '0.00000000',
              total: 0.1005,
              estimatedValue: 194.568,
              updatedAt: expect.any(Object)
            },
            quoteAssetBalance: {
              asset: 'USDT',
              free: '535659.59823313',
              locked: '0.00000000'
            }
          });
        });
      });

      describe('when current price is not provided', () => {
        beforeEach(async () => {
          rawData = {
            accountInfo: accountInfoJSON,
            symbolInfo: {
              baseAsset: 'ETH',
              quoteAsset: 'USDT'
            },
            buy: {
              currentPrice: null
            }
          };

          result = await step.execute(logger, rawData);
        });

        it('retruns expected data', () => {
          expect(result).toStrictEqual({
            accountInfo: accountInfoJSON,
            symbolInfo: { baseAsset: 'ETH', quoteAsset: 'USDT' },
            buy: { currentPrice: null },
            baseAssetBalance: {
              asset: 'ETH',
              free: '0.10050000',
              locked: '0.00000000',
              total: 0.1005,
              estimatedValue: 0,
              updatedAt: expect.any(Object)
            },
            quoteAssetBalance: {
              asset: 'USDT',
              free: '535659.59823313',
              locked: '0.00000000'
            }
          });
        });
      });
    });

    describe('when cannot find base asset and quote asset', () => {
      beforeEach(async () => {
        rawData = {
          accountInfo: accountInfoJSON,
          symbolInfo: {
            baseAsset: 'QTUM',
            quoteAsset: 'TUSD'
          },
          buy: {
            currentPrice: null
          }
        };

        result = await step.execute(logger, rawData);
      });

      it('retruns expected data', () => {
        expect(result).toStrictEqual({
          accountInfo: accountInfoJSON,
          symbolInfo: { baseAsset: 'QTUM', quoteAsset: 'TUSD' },
          buy: { currentPrice: null },
          baseAssetBalance: {
            asset: 'QTUM',
            free: 0,
            locked: 0,
            total: 0,
            estimatedValue: 0,
            updatedAt: expect.any(Object)
          },
          quoteAssetBalance: {
            asset: 'TUSD',
            free: 0,
            locked: 0
          }
        });
      });
    });
  });
});
