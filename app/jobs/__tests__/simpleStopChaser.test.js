const config = require('config');
const { logger, cache, slack } = require('../../helpers');
const simpleStopChaserHelper = require('../simpleStopChaser/helper');
const { execute: simpleStopChaserExecute } = require('../simpleStopChaser');

jest.mock('config');
jest.mock('../simpleStopChaser/helper');

describe('simpleStopChaser', () => {
  let jobConfig;
  describe('execute', () => {
    beforeEach(() => {
      jobConfig = {
        cronTime: '* * * * * *',
        symbols: ['BTCUSDT', 'ETHUSDT'],
        candles: {
          interval: '4h',
          limit: 100
        },
        stopLossLimit: {
          lastBuyPercentage: 1.06,
          stopPercentage: 0.97,
          limitPercentage: 0.96
        }
      };

      config.get = jest.fn(key => {
        switch (key) {
          case 'jobs.simpleStopChaser':
            return jobConfig;
          default:
            return '';
        }
      });

      cache.hset = jest.fn().mockResolvedValue(true);
    });

    describe('when tradeaActionResult is buy if there is no cached last symbol', () => {
      beforeEach(async () => {
        cache.hget = jest.fn().mockResolvedValue();

        simpleStopChaserHelper.getIndicators = jest
          .fn()
          .mockResolvedValue({ some: 'value' });

        simpleStopChaserHelper.determineAction = jest.fn().mockResolvedValue({
          action: 'buy'
        });

        simpleStopChaserHelper.placeBuyOrder = jest
          .fn()
          .mockResolvedValue({ result: true });

        await simpleStopChaserExecute(logger);
      });

      it('triggers getIndicator', () => {
        expect(simpleStopChaserHelper.getIndicators).toHaveBeenCalledWith(
          'BTCUSDT',
          logger
        );
      });

      it('caches last processed time and symbol', () => {
        expect(cache.hset).toHaveBeenCalledWith(
          'simple-stop-chaser-common',
          'last-processed',
          expect.any(String)
        );
      });

      it('triggers placeBuyOrder', () => {
        expect(
          simpleStopChaserHelper.placeBuyOrder
        ).toHaveBeenCalledWith(logger, { some: 'value' });
      });
    });

    describe('when tradeaActionResult is sell if there is cached last symbol', () => {
      beforeEach(async () => {
        cache.hget = jest.fn().mockResolvedValue('BTCUSDT');

        simpleStopChaserHelper.getIndicators = jest
          .fn()
          .mockResolvedValue({ some: 'value' });

        simpleStopChaserHelper.determineAction = jest.fn().mockResolvedValue({
          action: 'sell'
        });

        simpleStopChaserHelper.placeBuyOrder = jest
          .fn()
          .mockResolvedValue({ result: true });

        await simpleStopChaserExecute(logger);
      });

      it('triggers getIndicator', () => {
        expect(simpleStopChaserHelper.getIndicators).toHaveBeenCalledWith(
          'ETHUSDT',
          logger
        );
      });

      it('caches last processed time and symbol', () => {
        expect(cache.hset).toHaveBeenCalledWith(
          'simple-stop-chaser-common',
          'last-processed',
          expect.any(String)
        );
      });

      it('does not trigger placeBuyOrder', () => {
        expect(simpleStopChaserHelper.placeBuyOrder).not.toHaveBeenCalled();
      });
    });

    describe('when tradeaActionResult is hold and there is cached last symbol and it is last symbol at symbols', () => {
      beforeEach(async () => {
        cache.hget = jest.fn().mockResolvedValue('ETHUSDT');

        simpleStopChaserHelper.getIndicators = jest
          .fn()
          .mockResolvedValue({ some: 'value' });

        simpleStopChaserHelper.determineAction = jest.fn().mockResolvedValue({
          action: 'wait'
        });

        simpleStopChaserHelper.placeBuyOrder = jest
          .fn()
          .mockResolvedValue({ result: true });

        simpleStopChaserHelper.chaseStopLossLimitOrder = jest
          .fn()
          .mockResolvedValue({ result: true });

        await simpleStopChaserExecute(logger);
      });

      it('does not trigger placeBuyOrder', () => {
        expect(simpleStopChaserHelper.placeBuyOrder).not.toHaveBeenCalled();
      });

      it('caches last processed time and symbol', () => {
        expect(cache.hset).toHaveBeenCalledWith(
          'simple-stop-chaser-common',
          'last-processed',
          expect.any(String)
        );
      });

      it('triggers chaseStopLossLimitOrder', () => {
        expect(
          simpleStopChaserHelper.chaseStopLossLimitOrder
        ).toHaveBeenCalledWith(logger, { some: 'value' });
      });
    });

    describe('throw exception', () => {
      describe('when exception is internal server error', () => {
        beforeEach(async () => {
          slack.sendMessage = jest.fn();

          const e = new Error('something happened');
          e.code = -1001;
          simpleStopChaserHelper.getIndicators = jest.fn().mockRejectedValue(e);

          simpleStopChaserHelper.placeOrder = jest
            .fn()
            .mockResolvedValue({ result: true });

          simpleStopChaserHelper.chaseStopLossLimitOrder = jest
            .fn()
            .mockResolvedValue({ result: true });

          await simpleStopChaserExecute(logger);
        });

        it('does not trigger placeOrder', () => {
          expect(simpleStopChaserHelper.placeOrder).not.toHaveBeenCalled();
        });

        it('does not trigger chaseStopLossLimitOrder', () => {
          expect(
            simpleStopChaserHelper.chaseStopLossLimitOrder
          ).not.toHaveBeenCalled();
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
          simpleStopChaserHelper.getIndicators = jest.fn().mockRejectedValue(e);

          simpleStopChaserHelper.placeOrder = jest
            .fn()
            .mockResolvedValue({ result: true });

          simpleStopChaserHelper.chaseStopLossLimitOrder = jest
            .fn()
            .mockResolvedValue({ result: true });

          await simpleStopChaserExecute(logger);
        });

        it('triggers slack', () => {
          expect(slack.sendMessage).toHaveBeenCalled();
        });
      });
    });
  });
});
