const bunyan = jest.createMockFromModule('bunyan');

const logger = {
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn()
};

logger.child = () => logger;

bunyan.createLogger = jest.fn(() => logger);
// eslint-disable-next-line no-underscore-dangle
bunyan.__logger = logger;

module.exports = bunyan;
