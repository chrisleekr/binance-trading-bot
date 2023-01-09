/* eslint-disable global-require */
const logger = require('../../../helpers/logger');

describe('queue', () => {
  let queue;

  let mockExecuteTrailingTrade;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();

    mockExecuteTrailingTrade = jest.fn().mockResolvedValue(true);

    jest.mock('../../../cronjob', () => ({
      executeTrailingTrade: mockExecuteTrailingTrade
    }));
  });

  describe('hold', () => {
    describe('when symbol does not exist in the queue', () => {
      beforeEach(async () => {
        queue = require('../queue');

        await queue.init(logger, ['BTCUSDT']);
        await queue.hold(logger, 'ETHUSDT');
      });

      it('does not trigger queue.pause for ETHUSDT', () => {
        expect(mockQueuePause).not.toHaveBeenCalled();
      });
    });

    describe('when symbol does exist in the queue', () => {
      describe('paused one time', () => {
        beforeEach(async () => {
          queue = require('../queue');

          await queue.init(logger, ['BTCUSDT']);
          await queue.hold(logger, 'BTCUSDT');
          mockQueueIsPaused.mockReturnValueOnce(true);
          await queue.execute(logger, 'BTCUSDT');
        });

        it('does trigger queue.pause once for BTCUSDT', () => {
          expect(mockQueuePause).toHaveBeenCalledTimes(1);
        });
      });

      describe('paused two times with active job', () => {
        beforeEach(async () => {
          mockQueueGetActiveCount.mockReturnValueOnce(1);

          queue = require('../queue');

          await queue.init(logger, ['BTCUSDT']);
          await queue.hold(logger, 'BTCUSDT');
          mockQueueIsPaused.mockReturnValueOnce(true);
          queue.hold(logger, 'BTCUSDT');
          await queue.execute(logger, 'BTCUSDT');
        });

        it('does trigger queue.pause once for BTCUSDT', () => {
          expect(mockQueuePause).toHaveBeenCalledTimes(1);
        });
      });

      describe('paused two times with waiting job', () => {
        beforeEach(async () => {
          mockQueueGetWaitingCount.mockReturnValueOnce(1);
          queue = require('../queue');

          await queue.init(logger, ['BTCUSDT']);
          await queue.hold(logger, 'BTCUSDT');
          mockQueueIsPaused.mockReturnValueOnce(true);
          queue.hold(logger, 'BTCUSDT');
          await queue.execute(logger, 'BTCUSDT');
        });

        it('does trigger queue.pause once for BTCUSDT', () => {
          expect(mockQueuePause).toHaveBeenCalledTimes(1);
        });
      });
    });
  });

  describe('init', () => {
    describe('called one time', () => {
      beforeEach(async () => {
        queue = require('../queue');

        await queue.init(logger, ['BTCUSDT', 'ETHUSDT', 'BNBUSDT']);
      });

      it('triggers new Queue for BTCUSDT', () => {
        expect(mockQueue).toHaveBeenCalledWith('BTCUSDT', expect.any(String), {
          prefix: `bull`,
          limiter: {
            max: 100,
            duration: 10000,
            bounceBack: true
          }
        });
      });

      it('triggers executeTrailingTrade for BTCUSDT', () => {
        expect(mockExecuteTrailingTrade).toHaveBeenCalledWith(
          logger,
          'BTCUSDT',
          'correlationId'
        );
      });

      it('triggers executeTrailingTrade for ETHUSDT', () => {
        expect(mockExecuteTrailingTrade).toHaveBeenCalledWith(
          logger,
          'ETHUSDT',
          'correlationId'
        );
      });

      it('triggers executeTrailingTrade for BNBUSDT', () => {
        expect(mockExecuteTrailingTrade).toHaveBeenCalledWith(
          logger,
          'BNBUSDT',
          'correlationId'
        );
      });

      it('triggers queue.process 3 times', () => {
        expect(mockQueueProcess).toHaveBeenCalledTimes(3);
      });

      it('does not trigger queue.obliterate', () => {
        expect(mockQueueObliterate).not.toHaveBeenCalled();
      });
    });

    describe('called two times', () => {
      beforeEach(async () => {
        queue = require('../queue');

        await queue.init(logger, ['BTCUSDT', 'ETHUSDT', 'BNBUSDT']);
        await queue.init(logger, ['BTCUSDT', 'ETHUSDT', 'BNBUSDT']);
      });

      it('triggers queue.obliterate 3 times', () => {
        expect(mockQueueObliterate).toHaveBeenCalledTimes(3);
      });

      it('triggers queue.process 6 times', () => {
        expect(mockQueueProcess).toHaveBeenCalledTimes(6);
      });
    });
  });

  describe('executeFor', () => {
    describe('when the symbol exists in the queue', () => {
      beforeEach(async () => {
        queue = require('../queue');

        await queue.init(logger, ['BTCUSDT']);
        await queue.execute(logger, 'BTCUSDT');
      });

      it('triggers queue.add for BTCUSDT', () => {
        expect(mockQueueAdd).toHaveBeenCalledWith(
          {},
          { removeOnComplete: 100 }
        );
      });
    });
    describe('when symbol does not exist in the queue', () => {
      beforeEach(async () => {
        queue = require('../queue');

        await queue.init(logger, ['BTCUSDT']);
        await queue.execute(logger, 'ETHUSDT');
      });

      it('does not trigger queue.add for ETHUSDT', () => {
        expect(mockQueueAdd).not.toHaveBeenCalled();
      });
    });
  });
});
