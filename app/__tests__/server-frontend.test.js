/* eslint-disable global-require */

describe('server-frontend', () => {
  let mockExpressStatic;
  let mockExpressUse;
  let mockExpressListen;
  let mockExpressServerOn;
  let mockExpressUrlEncoded;
  let mockExpressJson;

  let mockConfigureWebServer;
  let mockConfigureWebSocket;
  let mockConfigureLocalTunnel;

  let config;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();

    config = require('config');

    jest.mock('ws');
    jest.mock('config');

    mockConfigureWebServer = jest.fn().mockResolvedValue(true);
    mockConfigureWebSocket = jest.fn().mockResolvedValue(true);
    mockConfigureLocalTunnel = jest.fn().mockResolvedValue(true);

    mockExpressStatic = jest.fn().mockResolvedValue(true);
    mockExpressUse = jest.fn().mockResolvedValue(true);
    mockExpressUrlEncoded = jest.fn().mockResolvedValue(true);
    mockExpressJson = jest.fn().mockResolvedValue(true);

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

      Object.defineProperty(mockExpress, 'urlencoded', {
        value: mockExpressUrlEncoded
      });

      Object.defineProperty(mockExpress, 'json', {
        value: mockExpressJson
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

    jest.mock('../frontend/webserver/configure', () => ({
      configureWebServer: mockConfigureWebServer
    }));

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

    it('triggers configureWebServer', () => {
      expect(mockConfigureWebServer).toHaveBeenCalled();
    });

    it('triggers configureWebSocket', () => {
      expect(mockConfigureWebSocket).toHaveBeenCalled();
    });

    it('triggers configureLocalTunnel', () => {
      expect(mockConfigureLocalTunnel).toHaveBeenCalled();
    });
  });
});
