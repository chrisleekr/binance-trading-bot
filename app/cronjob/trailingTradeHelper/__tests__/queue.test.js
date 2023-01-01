/* eslint-disable global-require */
const logger = require('../../../helpers/logger');

describe('queue', () => {
  let queue;
  let mockQueueProcess;
  let mockQueueObliterate;
  let mockQueueAdd;
  let mockQueuePause;
  let mockQueueResume;
  let mockQueueGetActiveCount;
  let mockQueueGetWaitingCount;
  let mockQueueIsPaused;
  let mockQueue;

  let mockExecuteTrailingTrade;
  let mockSetBullBoardQueues;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();
    jest.mock('config');

    mockQueueProcess = jest.fn().mockImplementation((_concurrent, cb) => {
      const job = {
        data: { correlationId: 'correlationId' },
        progress: jest.fn()
      };
      cb(job);
    });

    mockQueueObliterate = jest.fn().mockResolvedValue(true);
    mockQueueAdd = jest.fn().mockResolvedValue(true);
    mockQueuePause = jest.fn().mockResolvedValue(true);
    mockQueueResume = jest.fn().mockResolvedValue(true);
    mockQueueGetActiveCount = jest.fn().mockResolvedValue(0);
    mockQueueGetWaitingCount = jest.fn().mockResolvedValue(0);
    mockQueueIsPaused = jest.fn().mockResolvedValue(false);
    mockExecuteTrailingTrade = jest.fn().mockResolvedValue(true);
    mockSetBullBoardQueues = jest.fn().mockResolvedValue(true);

    mockQueue = jest.fn().mockImplementation((_queueName, _redisUrl) => ({
      process: mockQueueProcess,
      add: mockQueueAdd,
      pause: mockQueuePause,
      resume: mockQueueResume,
      getActiveCount: mockQueueGetActiveCount,
      getWaitingCount: mockQueueGetWaitingCount,
      isPaused: mockQueueIsPaused,
      obliterate: mockQueueObliterate
    }));

    jest.mock('bull', () => mockQueue);

    jest.mock('../../../cronjob', () => ({
      executeTrailingTrade: mockExecuteTrailingTrade
    }));

    jest.mock('../../../frontend/bull-board/configure', () => ({
      setBullBoardQueues: mockSetBullBoardQueues
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
          await queue.executeFor(logger, 'BTCUSDT');
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
          await queue.executeFor(logger, 'BTCUSDT');
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
          await queue.executeFor(logger, 'BTCUSDT');
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

      it('triggers setBullBoardQueues 2 times', () => {
        expect(mockSetBullBoardQueues).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('executeFor', () => {
    describe('when the symbol exists in the queue', () => {
      beforeEach(async () => {
        queue = require('../queue');

        await queue.init(logger, ['BTCUSDT']);
        await queue.executeFor(logger, 'BTCUSDT');
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
        await queue.executeFor(logger, 'ETHUSDT');
      });

      it('does not trigger queue.add for ETHUSDT', () => {
        expect(mockQueueAdd).not.toHaveBeenCalled();
      });
    });
  });
});
