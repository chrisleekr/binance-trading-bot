/* eslint-disable global-require */
describe('logger', () => {
  let logger;
  let mockMongoInsertOne;

  let mockCreateLogger;
  const packageJson = require('../../../package.json');

  describe('when BINANCE_LOG_LEVEL is defined', () => {
    beforeEach(() => {
      jest.clearAllMocks().resetModules();

      process.env.BINANCE_LOG_LEVEL = 'ERROR';

      mockCreateLogger = jest.fn(() => ({
        info: jest.fn()
      }));

      mockMongoInsertOne = jest.fn().mockResolvedValue(true);

      jest.mock('../mongo', () => ({
        insertOne: mockMongoInsertOne
      }));

      jest.mock('bunyan', () => ({
        createLogger: mockCreateLogger
      }));
      logger = require('../logger');
    });

    it('triggers createLogger', () => {
      expect(mockCreateLogger).toHaveBeenCalledWith({
        name: 'binance-api',
        version: packageJson.version,
        streams: [
          { stream: process.stdout, level: 'ERROR' },
          { stream: expect.any(Object), level: 'INFO' }
        ]
      });
    });

    it('returns expected', () => {
      expect(logger.info).toBeDefined();
    });
  });

  describe('when BINANCE_LOG_LEVEL is not defined', () => {
    beforeEach(() => {
      jest.clearAllMocks().resetModules();

      delete process.env.BINANCE_LOG_LEVEL;

      mockCreateLogger = jest.fn(() => ({
        info: jest.fn()
      }));

      mockMongoInsertOne = jest.fn().mockResolvedValue(true);

      jest.mock('../mongo', () => ({
        insertOne: mockMongoInsertOne
      }));

      jest.mock('bunyan', () => ({
        createLogger: mockCreateLogger
      }));
      logger = require('../logger');
    });

    it('triggers createLogger', () => {
      expect(mockCreateLogger).toHaveBeenCalledWith({
        name: 'binance-api',
        version: packageJson.version,
        streams: [
          { stream: process.stdout, level: 'TRACE' },
          { stream: expect.any(Object), level: 'INFO' }
        ]
      });
    });

    it('returns expected', () => {
      expect(logger.info).toBeDefined();
    });
  });

  describe('InfoStream', () => {
    describe('saveLog is true', () => {
      describe('when symbol is not provided', () => {
        beforeEach(() => {
          jest.clearAllMocks().resetModules();

          mockMongoInsertOne = jest.fn().mockResolvedValue(true);

          jest.mock('../mongo', () => ({
            insertOne: mockMongoInsertOne
          }));

          mockCreateLogger = jest.fn(() => ({
            info: jest.fn()
          }));

          jest.mock('bunyan', () => ({
            createLogger: mockCreateLogger
          }));

          logger = require('../logger');

          mockCreateLogger.mock.calls[0][0].streams[1].stream.write(
            JSON.stringify({
              my: 'log',
              saveLog: true,
              msg: 'New log without symbol',
              time: '2021-10-16T20:48:54.772Z'
            })
          );
        });

        it('does not trigger mongo.insertOne', () => {
          expect(mockMongoInsertOne).not.toHaveBeenCalled();
        });
      });

      describe('when log is not same', () => {
        beforeEach(() => {
          jest.clearAllMocks().resetModules();

          mockMongoInsertOne = jest.fn().mockResolvedValue(true);

          jest.mock('../mongo', () => ({
            insertOne: mockMongoInsertOne
          }));

          mockCreateLogger = jest.fn(() => ({
            info: jest.fn()
          }));

          jest.mock('bunyan', () => ({
            createLogger: mockCreateLogger
          }));

          logger = require('../logger');

          mockCreateLogger.mock.calls[0][0].streams[1].stream.write(
            JSON.stringify({
              my: 'log',
              saveLog: true,
              msg: 'New log',
              symbol: 'BTCUSDT',
              time: '2021-10-16T20:48:54.772Z'
            })
          );
        });

        it('triggers mongo.insertOne', () => {
          expect(mockMongoInsertOne).toHaveBeenCalledWith(
            expect.any(Object),
            'trailing-trade-logs',
            {
              data: {
                my: 'log'
              },
              loggedAt: expect.any(Date),
              msg: 'New log',
              symbol: 'BTCUSDT'
            }
          );
        });
      });

      describe('when log is  same', () => {
        beforeEach(() => {
          jest.clearAllMocks().resetModules();

          mockMongoInsertOne = jest.fn().mockResolvedValue(true);

          jest.mock('../mongo', () => ({
            insertOne: mockMongoInsertOne
          }));

          mockCreateLogger = jest.fn(() => ({
            info: jest.fn()
          }));

          jest.mock('bunyan', () => ({
            createLogger: mockCreateLogger
          }));

          logger = require('../logger');

          mockCreateLogger.mock.calls[0][0].streams[1].stream.write(
            JSON.stringify({
              my: 'log',
              saveLog: true,
              msg: 'New log',
              symbol: 'BTCUSDT',
              time: '2021-10-16T20:48:54.772Z'
            })
          );

          mockCreateLogger.mock.calls[0][0].streams[1].stream.write(
            JSON.stringify({
              my: 'log',
              saveLog: true,
              msg: 'New log',
              symbol: 'BTCUSDT',
              time: '2021-10-16T20:48:54.772Z'
            })
          );
        });

        it('triggers mongo.insertOne', () => {
          expect(mockMongoInsertOne).toHaveBeenCalledWith(
            expect.any(Object),
            'trailing-trade-logs',
            {
              data: {
                my: 'log'
              },
              loggedAt: expect.any(Date),
              msg: 'New log',
              symbol: 'BTCUSDT'
            }
          );
        });

        it('triggers mongo.insertOne once', () => {
          expect(mockMongoInsertOne).toHaveBeenCalledTimes(1);
        });
      });
    });
  });
});
