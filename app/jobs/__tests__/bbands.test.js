const bbandsHelper = require('../bbands/helper');
const { logger, slack } = require('../../helpers');
const { execute: bbandsExecute } = require('../bbands');

jest.mock('../bbands/helper');

describe('bbands', () => {
  describe('execute', () => {
    describe('when tradeAction is buy', () => {
      beforeEach(async () => {
        bbandsHelper.getIndicators = jest.fn().mockResolvedValue({ some: 'value' });

        bbandsHelper.determineAction = jest.fn().mockReturnValue('buy');

        bbandsHelper.placeOrder = jest.fn().mockResolvedValue({ result: true });

        await bbandsExecute(logger);
      });

      it('triggers placeOrder', () => {
        expect(bbandsHelper.placeOrder).toHaveBeenCalledWith(logger, 'buy', 100, { some: 'value' });
      });
    });

    describe('when tradeAction is sell', () => {
      beforeEach(async () => {
        bbandsHelper.getIndicators = jest.fn().mockResolvedValue({ some: 'value' });

        bbandsHelper.determineAction = jest.fn().mockReturnValue('sell');

        bbandsHelper.placeOrder = jest.fn().mockResolvedValue({ result: true });

        await bbandsExecute(logger);
      });

      it('triggers placeOrder', () => {
        expect(bbandsHelper.placeOrder).toHaveBeenCalledWith(logger, 'sell', 100, { some: 'value' });
      });
    });

    describe('when tradeAction is hold', () => {
      beforeEach(async () => {
        bbandsHelper.getIndicators = jest.fn().mockResolvedValue({ some: 'value' });

        bbandsHelper.determineAction = jest.fn().mockReturnValue('hold');

        bbandsHelper.placeOrder = jest.fn().mockResolvedValue({ result: true });

        await bbandsExecute(logger);
      });

      it('does not trigger placeOrder', () => {
        expect(bbandsHelper.placeOrder).not.toHaveBeenCalled();
      });
    });

    describe('throw exception', () => {
      beforeEach(async () => {
        slack.sendMessage = jest.fn();
        const e = new Error('something happened');

        bbandsHelper.getIndicators = jest.fn().mockRejectedValue(e);

        bbandsHelper.determineAction = jest.fn();

        bbandsHelper.placeOrder = jest.fn();

        await bbandsExecute(logger);
      });

      it('does not trigger placeOrder', () => {
        expect(bbandsHelper.placeOrder).not.toHaveBeenCalled();
      });

      it('triggers slack', () => {
        expect(slack.sendMessage).toHaveBeenCalled();
      });
    });
  });
});
