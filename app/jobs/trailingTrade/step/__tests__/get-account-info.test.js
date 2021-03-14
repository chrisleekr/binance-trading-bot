const { binance, logger } = require('../../../../helpers');

const step = require('../get-account-info');

describe('get-account-info.js', () => {
  let result;
  let rawData;

  describe('execute', () => {
    beforeEach(async () => {
      binance.client.accountInfo = jest.fn().mockResolvedValue({
        updateTime: '1611365234776',
        balances: [
          { asset: 'BTC', free: '0.00100000', locked: '0.99900000' },
          { asset: 'ETH', free: '0.00000000', locked: '0.00000000' }
        ]
      });

      rawData = {};

      result = await step.execute(logger, rawData);
    });

    it('return expected result', () => {
      expect(result).toStrictEqual({
        accountInfo: {
          updateTime: '1611365234776',
          balances: [{ asset: 'BTC', free: '0.00100000', locked: '0.99900000' }]
        }
      });
    });
  });
});
