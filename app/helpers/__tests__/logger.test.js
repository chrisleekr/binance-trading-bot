/* eslint-disable global-require */
describe('logger', () => {
  let bunyan;
  let logger;
  let mockCreateLogger;
  const packageJson = require('../../../package.json');

  beforeEach(() => {
    jest.clearAllMocks().resetModules();

    mockCreateLogger = jest.fn(() => ({
      info: jest.fn()
    }));

    jest.mock('bunyan', () => ({
      createLogger: mockCreateLogger
    }));
    bunyan = require('bunyan');
    logger = require('../logger');
  });

  it('triggers createLogger', () => {
    expect(mockCreateLogger).toHaveBeenCalledWith({
      name: 'binance-api',
      version: packageJson.version,
      streams: [{ stream: process.stdout, level: bunyan.TRACE }]
    });
  });

  it('returns expected', () => {
    expect(logger.info).toBeDefined();
  });
});
