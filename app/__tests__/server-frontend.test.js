/* eslint-disable global-require */
const config = require('config');
const { logger } = require('../helpers');

describe('server-frontend', () => {
  let mockExpressStatic;
  let mockExpressUse;
  let mockExpressListen;
  beforeEach(() => {
    jest.clearAllMocks().resetModules();

    jest.mock('config');

    mockExpressStatic = jest.fn().mockResolvedValue(true);
    mockExpressUse = jest.fn().mockResolvedValue(true);
    mockExpressListen = jest.fn().mockResolvedValue(true);

    jest.mock('express', () => {
      const mockExpress = () => ({
        use: mockExpressUse,
        listen: mockExpressListen
      });
      Object.defineProperty(mockExpress, 'static', {
        value: mockExpressStatic
      });

      return mockExpress;
    });

    config.get = jest.fn(key => {
      switch (key) {
        case 'mode':
          return 'test';
        default:
          return `value-${key}`;
      }
    });

    const { runFrontend } = require('../server-frontend');
    runFrontend(logger);
  });

  it('triggers server.listen', () => {
    expect(mockExpressListen).toHaveBeenCalledWith(80);
  });
});
