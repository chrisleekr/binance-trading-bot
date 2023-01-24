/* eslint-disable global-require */
const logger = require('../../../helpers/logger');

describe('queue', () => {
  let queue;

  let loggerMock;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();

    loggerMock = logger;
  });

  describe('execute', () => {
    describe('when symbol does not exist in the queue', () => {
      beforeEach(async () => {
        queue = require('../queue');

        await queue.execute(logger, 'ETHUSDT');
      });

      it('triggers logger.info', () => {
        expect(loggerMock.info).toHaveBeenCalledWith(
          { symbol: 'ETHUSDT' },
          'Queue ETHUSDT initialized'
        );
      });
    });

    describe('when the symbol exists in the queue', () => {
      let mockPreprocessFn;
      let mockProcessFn;
      let mockPostprocessFn;
      describe('when executed once', () => {
        beforeEach(async () => {
          queue = require('../queue');

          mockProcessFn = jest.fn().mockResolvedValue(true);

          await queue.prepareJob(logger, 'BTCUSDT');
          await queue.completeJob(logger, 'BTCUSDT');
          await queue.execute(logger, 'BTCUSDT', { processFn: mockProcessFn });
        });

        it('triggers process', () => {
          expect(mockProcessFn).toHaveBeenCalledTimes(1);
        });

        it('triggers process for BTCUSDT', () => {
          expect(mockProcessFn).toHaveBeenCalledWith(
            loggerMock,
            'BTCUSDT',
            undefined
          );
        });
      });

      describe('when executed twice', () => {
        beforeEach(async () => {
          queue = require('../queue');

          await queue.prepareJob(logger, 'BTCUSDT');
          await queue.completeJob(logger, 'BTCUSDT');
          queue.execute(logger, 'BTCUSDT', { processFn: mockProcessFn });
          await queue.execute(logger, 'BTCUSDT', { processFn: mockProcessFn });
        });

        it('triggers process 2 times', () => {
          expect(mockProcessFn).toHaveBeenCalledTimes(2);
        });

        it('triggers process for BTCUSDT', () => {
          expect(mockProcessFn).toHaveBeenCalledWith(
            loggerMock,
            'BTCUSDT',
            undefined
          );
        });
      });

      describe('when executed with truthy preprocessing', () => {
        beforeEach(async () => {
          queue = require('../queue');

          mockPreprocessFn = jest.fn().mockResolvedValue(true);
          mockProcessFn = jest.fn().mockResolvedValue(true);
          mockPostprocessFn = jest.fn().mockResolvedValue(true);
          await queue.execute(logger, 'BTCUSDT', {
            preprocessFn: mockPreprocessFn,
            processFn: mockProcessFn,
            postprocessFn: mockPostprocessFn
          });
        });

        it('triggers preprocessFn for BTCUSDT', () => {
          expect(mockPreprocessFn).toHaveBeenCalledTimes(1);
        });

        it('triggers process', () => {
          expect(mockProcessFn).toHaveBeenCalledTimes(1);
        });

        it('triggers process for BTCUSDT', () => {
          expect(mockProcessFn).toHaveBeenCalledWith(
            loggerMock,
            'BTCUSDT',
            undefined
          );
        });
        it('triggers postprocessFn for BTCUSDT', () => {
          expect(mockPostprocessFn).toHaveBeenCalledTimes(1);
        });
      });

      describe('when executed with falsy preprocessing', () => {
        beforeEach(async () => {
          queue = require('../queue');

          mockPreprocessFn = jest.fn().mockResolvedValue(false);
          mockProcessFn = jest.fn().mockResolvedValue(true);
          mockPostprocessFn = jest.fn().mockResolvedValue(true);
          await queue.execute(logger, 'BTCUSDT', {
            preprocessFn: mockPreprocessFn,
            processFn: mockProcessFn,
            postprocessFn: mockPostprocessFn
          });
        });

        it('triggers preprocessFn for BTCUSDT', () => {
          expect(mockPreprocessFn).toHaveBeenCalledTimes(1);
        });

        it('does not trigger process for BTCUSDT', () => {
          expect(mockProcessFn).not.toHaveBeenCalled();
        });

        it('does not trigger postprocessFn for BTCUSDT', () => {
          expect(mockPostprocessFn).not.toHaveBeenCalled();
        });
      });

      describe('when executed with processing only', () => {
        beforeEach(async () => {
          queue = require('../queue');

          mockProcessFn = jest.fn().mockResolvedValue(true);
          await queue.execute(logger, 'BTCUSDT', {
            processFn: mockProcessFn
          });
        });

        it('triggers process', () => {
          expect(mockProcessFn).toHaveBeenCalledTimes(1);
        });

        it('triggers process for BTCUSDT', () => {
          expect(mockProcessFn).toHaveBeenCalledWith(
            loggerMock,
            'BTCUSDT',
            undefined
          );
        });
      });

      describe('when executed with postprocessing only', () => {
        beforeEach(async () => {
          queue = require('../queue');

          mockPostprocessFn = jest.fn().mockResolvedValue(true);
          await queue.execute(logger, 'BTCUSDT', {
            postprocessFn: mockPostprocessFn
          });
        });

        it('triggers postprocessFn for BTCUSDT', () => {
          expect(mockPostprocessFn).toHaveBeenCalledTimes(1);
        });
      });
    });
  });
});
