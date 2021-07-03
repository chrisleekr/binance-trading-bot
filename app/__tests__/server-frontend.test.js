/* eslint-disable global-require */

describe('server-frontend', () => {
  let mockExpressStatic;
  let mockExpressUse;
  let mockExpressListen;
  let mockExpressServerOn;

  let mockConfigureWebSocket;
  let mockConfigureLocalTunnel;

  let config;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();

    config = require('config');

    jest.mock('ws');
    jest.mock('config');

    mockConfigureWebSocket = jest.fn().mockResolvedValue(true);
    mockConfigureLocalTunnel = jest.fn().mockResolvedValue(true);

    mockExpressStatic = jest.fn().mockResolvedValue(true);
    mockExpressUse = jest.fn().mockResolvedValue(true);

    mockExpressListen = jest.fn().mockReturnValue({
      on: mockExpressServerOn
    });

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

    jest.mock('../frontend/websocket/configure', () => ({
      configureWebSocket: mockConfigureWebSocket
    }));

    jest.mock('../frontend/local-tunnel/configure', () => ({
      configureLocalTunnel: mockConfigureLocalTunnel
    }));
  });

  describe('check web server', () => {
    beforeEach(() => {
      const { logger } = require('../helpers');
      const { runFrontend } = require('../server-frontend');
      runFrontend(logger);
    });

    it('triggers server.listen', () => {
      expect(mockExpressListen).toHaveBeenCalledWith(80);
    });

    it('triggers configureWebSocket', () => {
      expect(mockConfigureWebSocket).toHaveBeenCalled();
    });

    it('triggers configureLocalTunnel', () => {
      expect(mockConfigureLocalTunnel).toHaveBeenCalled();
    });
  });
});
