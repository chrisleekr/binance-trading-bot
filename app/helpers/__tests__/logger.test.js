/* eslint-disable global-require */
describe('logger', () => {
  let logger;
  let mockCreateLogger;
  const packageJson = require('../../../package.json');

  describe('when BINANCE_LOG_LEVEL is defined', () => {
    beforeEach(() => {
      jest.clearAllMocks().resetModules();

      process.env.BINANCE_LOG_LEVEL = 'ERROR';

      mockCreateLogger = jest.fn(() => ({
        info: jest.fn()
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
        streams: [{ stream: process.stdout, level: 'ERROR' }]
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

      jest.mock('bunyan', () => ({
        createLogger: mockCreateLogger
      }));
      logger = require('../logger');
    });

    it('triggers createLogger', () => {
      expect(mockCreateLogger).toHaveBeenCalledWith({
        name: 'binance-api',
        version: packageJson.version,
        streams: [{ stream: process.stdout, level: 'TRACE' }]
      });
    });

    it('returns expected', () => {
      expect(logger.info).toBeDefined();
    });
  });
});
