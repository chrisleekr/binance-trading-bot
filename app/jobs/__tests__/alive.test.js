const aliveHelper = require('../alive/helper');
const { logger, slack } = require('../../helpers');
const { execute: aliveExecute } = require('../alive');

jest.mock('../alive/helper');

describe('alive', () => {
  describe('execute', () => {
    describe('success', () => {
      beforeEach(async () => {
        aliveHelper.getBalance = jest.fn().mockResolvedValue({ some: 'value' });
        slack.sendMessage = jest.fn();

        await aliveExecute(logger);
      });

      it('triggers getBalance', () => {
        expect(aliveHelper.getBalance).toHaveBeenCalled();
      });

      it('triggers slack', () => {
        expect(slack.sendMessage).toHaveBeenCalled();
      });
    });

    describe('throw exception', () => {
      beforeEach(async () => {
        const e = new Error('something happened');

        aliveHelper.getBalance = jest.fn().mockRejectedValue(e);
        slack.sendMessage = jest.fn();

        await aliveExecute(logger);
      });

      it('triggers slack', () => {
        expect(slack.sendMessage).toHaveBeenCalled();
      });
    });
  });
});
