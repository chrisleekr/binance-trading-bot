/* eslint-disable global-require */
const { binance, logger } = require('../../../helpers');

const aliveHelper = require('../helper');

jest.mock('config');

describe('helper', () => {
  let result;

  describe('getAccountInfo', () => {
    beforeEach(async () => {
      binance.client.accountInfo = jest.fn().mockResolvedValue({
        updateTime: '1611365234776',
        balances: [
          { asset: 'BTC', free: '0.00100000', locked: '0.99900000' },
          { asset: 'ETH', free: '0.00000000', locked: '0.00000000' }
        ]
      });

      result = await aliveHelper.getAccountInfo(logger);
    });

    it('return expected result', () => {
      expect(result).toStrictEqual({
        updateTime: '1611365234776',
        balances: [{ asset: 'BTC', free: '0.00100000', locked: '0.99900000' }]
      });
    });
  });
});
