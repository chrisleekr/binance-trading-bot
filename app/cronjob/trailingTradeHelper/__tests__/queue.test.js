/* eslint-disable global-require */
const logger = require('../../../helpers/logger');

describe('queue', () => {
  let queue;
  let mockQueueProcess;
  let mockQueueObliterate;
  let mockQueueAdd;
  let mockQueue;

  let mockExecuteTrailingTrade;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();
    jest.mock('config');

    mockQueueProcess = jest.fn().mockImplementation(cb => {
      cb();
    });
    mockQueueObliterate = jest.fn().mockResolvedValue(true);
    mockQueueAdd = jest.fn().mockResolvedValue(true);
    mockExecuteTrailingTrade = jest.fn().mockResolvedValue(true);

    mockQueue = jest.fn().mockImplementation((_queueName, _redisUrl) => ({
      process: mockQueueProcess,
      add: mockQueueAdd,
      obliterate: mockQueueObliterate
    }));

    jest.mock('bull', () => mockQueue);

    jest.mock('../../../cronjob', () => ({
      executeTrailingTrade: mockExecuteTrailingTrade
    }));
  });

  describe('init', () => {
    describe('called one time', () => {
      beforeEach(async () => {
        queue = require('../queue');

        await queue.init(logger, ['BTCUSDT', 'ETHUSDT', 'BNBUSDT']);
      });

      it('triggers new Queue for BTCUSDT', () => {
        expect(mockQueue).toHaveBeenCalledWith('BTCUSDT', expect.any(String));
      });

      it('triggers executeTrailingTrade for BTCUSDT', () => {
        expect(mockExecuteTrailingTrade).toHaveBeenCalledWith(
          logger,
          'BTCUSDT'
        );
      });

      it('triggers executeTrailingTrade for ETHUSDT', () => {
        expect(mockExecuteTrailingTrade).toHaveBeenCalledWith(
          logger,
          'ETHUSDT'
        );
      });

      it('triggers executeTrailingTrade for BNBUSDT', () => {
        expect(mockExecuteTrailingTrade).toHaveBeenCalledWith(
          logger,
          'BNBUSDT'
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
    beforeEach(async () => {
      queue = require('../queue');

      await queue.init(logger, ['BTCUSDT']);
      await queue.executeFor(logger, 'BTCUSDT');
    });

    it('triggers queue.add for BTCUSDT', () => {
      expect(mockQueueAdd).toHaveBeenCalledWith({});
    });
  });
});
