/* eslint-disable global-require */
const logger = require('../../../helpers/logger');

describe('queue', () => {
  let queue;

  let loggerMock;

  let mockExecuteTrailingTrade;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();

    mockExecuteTrailingTrade = jest.fn().mockResolvedValue(true);

    jest.mock('../../../cronjob', () => ({
      executeTrailingTrade: mockExecuteTrailingTrade
    }));

    loggerMock = logger;
  });

  describe('init', () => {
    describe('called one time', () => {
      beforeEach(async () => {
        queue = require('../queue');

        await queue.init(logger, ['BTCUSDT', 'ETHUSDT', 'BNBUSDT']);
      });

      it('triggers logger.info', () => {
        expect(loggerMock.info).toHaveBeenCalledWith(
          { symbols: ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'] },
          'Queue initialized'
        );
      });
    });

    describe('called two times', () => {
      beforeEach(async () => {
        queue = require('../queue');

        await queue.init(logger, ['BTCUSDT', 'ETHUSDT', 'BNBUSDT']);
        await queue.init(logger, ['BTCUSDT', 'ETHUSDT', 'BNBUSDT']);
      });

      it('triggers logger.info 2 times', () => {
        expect(loggerMock.info).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('execute', () => {
    describe('when symbol does not exist in the queue', () => {
      beforeEach(async () => {
        queue = require('../queue');

        await queue.init(logger, ['BTCUSDT']);
        await queue.execute(logger, 'ETHUSDT');
      });

      it('triggers logger.error', () => {
        expect(loggerMock.error).toHaveBeenCalledWith(
          { symbol: 'ETHUSDT' },
          'No queue created for ETHUSDT'
        );
      });

      it('does not trigger executeTrailingTrade for ETHUSDT', () => {
        expect(mockExecuteTrailingTrade).not.toHaveBeenCalled();
      });
    });

    describe('when the symbol exists in the queue', () => {
      describe('when executed once', () => {
        beforeEach(async () => {
          queue = require('../queue');

          await queue.init(logger, ['BTCUSDT']);
          await queue.execute(logger, 'BTCUSDT');
        });

        it('triggers executeTrailingTrade', () => {
          expect(mockExecuteTrailingTrade).toHaveBeenCalledTimes(1);
        });

        it('triggers executeTrailingTrade for BTCUSDT', () => {
          expect(mockExecuteTrailingTrade).toHaveBeenCalledWith(
            loggerMock,
            'BTCUSDT',
            undefined
          );
        });
      });

      describe('when executed twice', () => {
        beforeEach(async () => {
          queue = require('../queue');

          await queue.init(logger, ['BTCUSDT']);
          queue.execute(logger, 'BTCUSDT');
          await queue.execute(logger, 'BTCUSDT');
        });

        it('triggers executeTrailingTrade 2 times', () => {
          expect(mockExecuteTrailingTrade).toHaveBeenCalledTimes(2);
        });

        it('triggers executeTrailingTrade for BTCUSDT', () => {
          expect(mockExecuteTrailingTrade).toHaveBeenCalledWith(
            loggerMock,
            'BTCUSDT',
            undefined
          );
        });
      });

      describe('when executed with truthy preprocessing', () => {
        let mockPreprocessFn;
        let mockPostprocessFn;
        beforeEach(async () => {
          queue = require('../queue');

          mockPreprocessFn = jest.fn().mockResolvedValue(true);
          mockPostprocessFn = jest.fn().mockResolvedValue(true);
          await queue.init(logger, ['BTCUSDT']);
          await queue.execute(logger, 'BTCUSDT', {
            preprocessFn: mockPreprocessFn,
            postprocessFn: mockPostprocessFn
          });
        });

        it('triggers preprocessFn for BTCUSDT', () => {
          expect(mockPreprocessFn).toHaveBeenCalledTimes(1);
        });

        it('triggers executeTrailingTrade', () => {
          expect(mockExecuteTrailingTrade).toHaveBeenCalledTimes(1);
        });

        it('triggers executeTrailingTrade for BTCUSDT', () => {
          expect(mockExecuteTrailingTrade).toHaveBeenCalledWith(
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
        let mockPreprocessFn;
        let mockPostprocessFn;
        beforeEach(async () => {
          queue = require('../queue');

          mockPreprocessFn = jest.fn().mockResolvedValue(false);
          mockPostprocessFn = jest.fn().mockResolvedValue(true);
          await queue.init(logger, ['BTCUSDT']);
          await queue.execute(logger, 'BTCUSDT', {
            preprocessFn: mockPreprocessFn,
            postprocessFn: mockPostprocessFn
          });
        });

        it('triggers preprocessFn for BTCUSDT', () => {
          expect(mockPreprocessFn).toHaveBeenCalledTimes(1);
        });

        it('does not trigger executeTrailingTrade for BTCUSDT', () => {
          expect(mockExecuteTrailingTrade).not.toHaveBeenCalled();
        });

        it('does not trigger postprocessFn for BTCUSDT', () => {
          expect(mockPostprocessFn).not.toHaveBeenCalled();
        });
      });

      describe('when executed with postprocessing only', () => {
        let mockPostprocessFn;
        beforeEach(async () => {
          queue = require('../queue');

          mockPostprocessFn = jest.fn().mockResolvedValue(true);
          await queue.init(logger, ['BTCUSDT']);
          await queue.execute(logger, 'BTCUSDT', {
            postprocessFn: mockPostprocessFn
          });
        });

        it('triggers executeTrailingTrade', () => {
          expect(mockExecuteTrailingTrade).toHaveBeenCalledTimes(1);
        });

        it('triggers executeTrailingTrade for BTCUSDT', () => {
          expect(mockExecuteTrailingTrade).toHaveBeenCalledWith(
            loggerMock,
            'BTCUSDT',
            undefined
          );
        });

        it('triggers postprocessFn for BTCUSDT', () => {
          expect(mockPostprocessFn).toHaveBeenCalledTimes(1);
        });
      });
    });
  });
});
