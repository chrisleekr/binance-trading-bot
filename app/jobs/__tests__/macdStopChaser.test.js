const { logger, slack } = require('../../helpers');
const macdStopChaserHelper = require('../macdStopChaser/helper');
const { execute: macdStopChaserExecute } = require('../macdStopChaser');

jest.mock('../macdStopChaser/helper');

describe('macdStopChaser', () => {
  describe('execute', () => {
    describe('when tradeaActionResult is buy', () => {
      beforeEach(async () => {
        macdStopChaserHelper.getIndicators = jest.fn().mockResolvedValue({ some: 'value' });

        macdStopChaserHelper.determineAction = jest.fn().mockResolvedValue({
          action: 'buy'
        });

        macdStopChaserHelper.placeOrder = jest.fn().mockResolvedValue({ result: true });

        await macdStopChaserExecute(logger);
      });

      it('triggers placeOrder', () => {
        expect(macdStopChaserHelper.placeOrder).toHaveBeenCalledWith(logger, 'buy', 100, { some: 'value' });
      });
    });

    describe('when tradeaActionResult is sell', () => {
      beforeEach(async () => {
        macdStopChaserHelper.getIndicators = jest.fn().mockResolvedValue({ some: 'value' });

        macdStopChaserHelper.determineAction = jest.fn().mockResolvedValue({
          action: 'sell'
        });

        macdStopChaserHelper.placeOrder = jest.fn().mockResolvedValue({ result: true });

        await macdStopChaserExecute(logger);
      });

      it('does not trigger placeOrder', () => {
        expect(macdStopChaserHelper.placeOrder).not.toHaveBeenCalled();
      });
    });

    describe('when tradeaActionResult is hold', () => {
      beforeEach(async () => {
        macdStopChaserHelper.getIndicators = jest.fn().mockResolvedValue({ some: 'value' });

        macdStopChaserHelper.determineAction = jest.fn().mockResolvedValue({
          action: 'hold'
        });

        macdStopChaserHelper.placeOrder = jest.fn().mockResolvedValue({ result: true });

        macdStopChaserHelper.chaseStopLossLimitOrder = jest.fn().mockResolvedValue({ result: true });

        await macdStopChaserExecute(logger);
      });

      it('does not trigger placeOrder', () => {
        expect(macdStopChaserHelper.placeOrder).not.toHaveBeenCalled();
      });

      it('triggers chaseStopLossLimitOrder', () => {
        expect(macdStopChaserHelper.chaseStopLossLimitOrder).toHaveBeenCalledWith(logger, { some: 'value' });
      });
    });

    describe('throw exception', () => {
      describe('when exception is internal server error', () => {
        beforeEach(async () => {
          slack.sendMessage = jest.fn();

          const e = new Error('something happened');
          e.code = -1001;
          macdStopChaserHelper.getIndicators = jest.fn().mockRejectedValue(e);

          macdStopChaserHelper.placeOrder = jest.fn().mockResolvedValue({ result: true });

          macdStopChaserHelper.chaseStopLossLimitOrder = jest.fn().mockResolvedValue({ result: true });

          await macdStopChaserExecute(logger);
        });

        it('does not trigger placeOrder', () => {
          expect(macdStopChaserHelper.placeOrder).not.toHaveBeenCalled();
        });

        it('does not trigger chaseStopLossLimitOrder', () => {
          expect(macdStopChaserHelper.chaseStopLossLimitOrder).not.toHaveBeenCalled();
        });

        it('does not trigger slack', () => {
          expect(slack.sendMessage).not.toHaveBeenCalled();
        });
      });

      describe('other exceptions', () => {
        beforeEach(async () => {
          slack.sendMessage = jest.fn();

          const e = new Error('something happened');
          e.code = -1;
          macdStopChaserHelper.getIndicators = jest.fn().mockRejectedValue(e);

          macdStopChaserHelper.placeOrder = jest.fn().mockResolvedValue({ result: true });

          macdStopChaserHelper.chaseStopLossLimitOrder = jest.fn().mockResolvedValue({ result: true });

          await macdStopChaserExecute(logger);
        });

        it('triggers slack', () => {
          expect(slack.sendMessage).toHaveBeenCalled();
        });
      });
    });
  });
});
