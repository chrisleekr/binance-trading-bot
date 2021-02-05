const aliveHelper = require('../alive/helper');
const { logger, slack } = require('../../helpers');
const { execute: aliveExecute } = require('../alive');

jest.mock('../alive/helper');

describe('alive', () => {
  describe('execute', () => {
    describe('success', () => {
      beforeEach(async () => {
        aliveHelper.getAccountInfo = jest.fn().mockResolvedValue({
          updateTime: '1611365234776',
          balances: [
            {
              asset: 'BNB',
              free: '1000.00000000',
              locked: '0.00000000'
            },
            {
              asset: 'BTC',
              free: '0.00100000',
              locked: '0.99900000'
            }
          ]
        });
        slack.sendMessage = jest.fn();

        await aliveExecute(logger);
      });

      it('triggers getAccountInfo', () => {
        expect(aliveHelper.getAccountInfo).toHaveBeenCalled();
      });

      it('triggers slack', () => {
        expect(slack.sendMessage).toHaveBeenCalled();
      });
    });

    describe('throw exception', () => {
      beforeEach(async () => {
        const e = new Error('something happened');

        aliveHelper.getAccountInfo = jest.fn().mockRejectedValue(e);
        slack.sendMessage = jest.fn();

        await aliveExecute(logger);
      });

      it('triggers slack', () => {
        expect(slack.sendMessage).toHaveBeenCalled();
      });
    });
  });
});
