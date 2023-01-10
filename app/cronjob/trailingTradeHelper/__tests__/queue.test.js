/* eslint-disable global-require */
const logger = require('../../../helpers/logger');

describe('queue', () => {
  let queue;

  let mockLogger;

  let mockExecuteTrailingTrade;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();

    mockExecuteTrailingTrade = jest.fn().mockResolvedValue(true);

    jest.mock('../../../cronjob', () => ({
      executeTrailingTrade: mockExecuteTrailingTrade
    }));

    mockLogger = logger;
  });

  describe('init', () => {
    describe('called one time', () => {
      beforeEach(async () => {
        queue = require('../queue');

        await queue.init(logger, ['BTCUSDT', 'ETHUSDT', 'BNBUSDT']);
      });

      it('triggers logger.info', () => {
        expect(mockLogger.info).toHaveBeenCalledWith(
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
        expect(mockLogger.info).toHaveBeenCalledTimes(2);
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
        expect(mockLogger.error).toHaveBeenCalledWith(
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

        it('triggers executeTrailingTrade for BTCUSDT', () => {
          expect(mockExecuteTrailingTrade).toHaveBeenCalledTimes(1);
        });
      });

      describe('when executed twice', () => {
        beforeEach(async () => {
          queue = require('../queue');

          await queue.init(logger, ['BTCUSDT']);
          queue.execute(logger, 'BTCUSDT');
          await queue.execute(logger, 'BTCUSDT');
        });

        it('triggers executeTrailingTrade for BTCUSDT', () => {
          expect(mockExecuteTrailingTrade).toHaveBeenCalledTimes(2);
        });
      });

      describe('when executed with forced trailing trade', () => {
        beforeEach(async () => {
          queue = require('../queue');

          await queue.init(logger, ['BTCUSDT']);
          await queue.execute(logger, 'BTCUSDT', {
            queue: true
          });
        });

        it('triggers executeTrailingTrade for BTCUSDT', () => {
          expect(mockExecuteTrailingTrade).toHaveBeenCalledTimes(1);
        });
      });

      describe('when executed with denied trailing trade', () => {
        beforeEach(async () => {
          queue = require('../queue');

          await queue.init(logger, ['BTCUSDT']);
          await queue.execute(logger, 'BTCUSDT', {
            queue: false
          });
        });

        it('does not trigger executeTrailingTrade for BTCUSDT', () => {
          expect(mockExecuteTrailingTrade).not.toHaveBeenCalled();
        });
      });

      describe('when executed with preprocessing', () => {
        beforeEach(async () => {
          queue = require('../queue');

          await queue.init(logger, ['BTCUSDT']);
          await queue.execute(logger, 'BTCUSDT', {
            preprocessFn: () => true
          });
        });

        it('triggers executeTrailingTrade for BTCUSDT', () => {
          expect(mockExecuteTrailingTrade).toHaveBeenCalledTimes(1);
        });
      });
    });
  });
});
