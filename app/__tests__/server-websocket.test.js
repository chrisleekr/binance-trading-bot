/* eslint-disable global-require */
const config = require('config');

describe('server-websocket', () => {
  let WebSocket;

  let mockServerOn;
  let mockServerWebSocketOn;
  let mockServerWebSocketSend;

  let cacheMock;
  let wss;

  beforeEach(() => {
    config.get = jest.fn(key => {
      switch (key) {
        case 'mode':
          return 'test';
        default:
          return `value-${key}`;
      }
    });
  });

  describe('when message is not JSON', () => {
    beforeEach(() => {
      jest.clearAllMocks().resetModules();

      WebSocket = require('ws');

      jest.mock('config');
      jest.mock('ws');

      mockServerWebSocketOn = jest.fn().mockImplementation((_event, cb) => {
        cb('not-json');
      });

      mockServerWebSocketSend = jest.fn().mockReturnValue(true);

      mockServerOn = jest.fn().mockImplementation((_event, cb) => {
        cb({
          on: mockServerWebSocketOn,
          send: mockServerWebSocketSend
        });
      });

      WebSocket.Server.mockImplementation(() => ({
        on: mockServerOn
      }));
      const { logger } = require('../helpers');

      const { runWebSocket } = require('../server-websocket');
      runWebSocket(logger);
    });

    it('triggers ws.send with connection_success', () => {
      expect(mockServerWebSocketSend).toHaveBeenCalledWith(
        JSON.stringify({
          result: true,
          type: 'connection_success',
          message: 'You are successfully connected to WebSocket.'
        })
      );
    });

    it('triggers ws.send with error', () => {
      expect(mockServerWebSocketSend).toHaveBeenCalledWith(
        JSON.stringify({
          result: false,
          type: 'error',
          message: 'Command is not provided.'
        })
      );
    });

    it('returns wss', () => {
      expect(wss).not.toBeNull();
    });
  });

  describe('when message command is not defined', () => {
    beforeEach(() => {
      jest.clearAllMocks().resetModules();

      WebSocket = require('ws');

      jest.mock('config');
      jest.mock('ws');

      mockServerWebSocketOn = jest.fn().mockImplementation((_event, cb) => {
        cb(
          JSON.stringify({
            noCommand: 'here'
          })
        );
      });

      mockServerWebSocketSend = jest.fn().mockReturnValue(true);

      mockServerOn = jest.fn().mockImplementation((_event, cb) => {
        cb({
          on: mockServerWebSocketOn,
          send: mockServerWebSocketSend
        });
      });

      WebSocket.Server.mockImplementation(() => ({
        on: mockServerOn
      }));

      const { logger } = require('../helpers');

      const { runWebSocket } = require('../server-websocket');
      runWebSocket(logger);
    });

    it('triggers ws.send with connection_success', () => {
      expect(mockServerWebSocketSend).toHaveBeenCalledWith(
        JSON.stringify({
          result: true,
          type: 'connection_success',
          message: 'You are successfully connected to WebSocket.'
        })
      );
    });

    it('triggers ws.send with error', () => {
      expect(mockServerWebSocketSend).toHaveBeenCalledWith(
        JSON.stringify({
          result: false,
          type: 'error',
          message: 'Command is not provided.'
        })
      );
    });

    it('returns wss', () => {
      expect(wss).not.toBeNull();
    });
  });

  describe('when message command is unknown', () => {
    beforeEach(() => {
      jest.clearAllMocks().resetModules();

      WebSocket = require('ws');

      jest.mock('config');
      jest.mock('ws');

      mockServerWebSocketOn = jest.fn().mockImplementation((_event, cb) => {
        cb(
          JSON.stringify({
            command: 'no-valid'
          })
        );
      });

      mockServerWebSocketSend = jest.fn().mockReturnValue(true);

      mockServerOn = jest.fn().mockImplementation((_event, cb) => {
        cb({
          on: mockServerWebSocketOn,
          send: mockServerWebSocketSend
        });
      });

      WebSocket.Server.mockImplementation(() => ({
        on: mockServerOn
      }));

      const { logger } = require('../helpers');

      const { runWebSocket } = require('../server-websocket');
      runWebSocket(logger);
    });

    it('triggers ws.send with connection_success', () => {
      expect(mockServerWebSocketSend).toHaveBeenCalledWith(
        JSON.stringify({
          result: true,
          type: 'connection_success',
          message: 'You are successfully connected to WebSocket.'
        })
      );
    });

    it('triggers ws.send with error', () => {
      expect(mockServerWebSocketSend).toHaveBeenCalledWith(
        JSON.stringify({
          result: false,
          type: 'error',
          message: 'Command is not recognised.'
        })
      );
    });

    it('returns wss', () => {
      expect(wss).not.toBeNull();
    });
  });

  describe('when message command is latest', () => {
    const simpleStopChaserCommonJson = require('./fixtures/server-websocket-simple-stop-chaser-common.json');
    const simpleStopChaserSymbolsJson = require('./fixtures/server-websocket-simple-stop-chaser-symbols.json');
    const simpleStopChaserStatsJson = require('./fixtures/server-websocket-stats.json');

    beforeEach(() => {
      jest.clearAllMocks().resetModules();

      WebSocket = require('ws');

      jest.mock('config');
      jest.mock('ws');
      jest.mock('ioredis');

      mockServerWebSocketOn = jest.fn().mockImplementation((_event, cb) => {
        cb(
          JSON.stringify({
            command: 'latest'
          })
        );
      });

      mockServerWebSocketSend = jest.fn().mockReturnValue(true);

      mockServerOn = jest.fn().mockImplementation((_event, cb) => {
        cb({
          on: mockServerWebSocketOn,
          send: mockServerWebSocketSend
        });
      });

      WebSocket.Server.mockImplementation(() => ({
        on: mockServerOn
      }));

      const { cache, logger } = require('../helpers');
      cacheMock = cache;

      cacheMock.hgetall = jest.fn().mockImplementation(key => {
        if (key === 'simple-stop-chaser-common') {
          return simpleStopChaserCommonJson;
        }

        if (key === 'simple-stop-chaser-symbols') {
          return simpleStopChaserSymbolsJson;
        }

        return '';
      });

      cacheMock.hget = jest.fn().mockImplementation((key, field) => {
        if (key === 'simple-stop-chaser-common' && field === 'configuration') {
          return JSON.stringify({ enabled: true });
        }
        return '';
      });

      const { runWebSocket } = require('../server-websocket');
      runWebSocket(logger);
    });

    it('triggers ws.send with latest', () => {
      expect(mockServerWebSocketSend).toHaveBeenCalledWith(
        JSON.stringify({
          result: true,
          type: 'latest',
          stats: simpleStopChaserStatsJson,
          configuration: {
            enabled: true
          }
        })
      );
    });

    it('returns wss', () => {
      expect(wss).not.toBeNull();
    });
  });

  describe('when message command is setting-update', () => {
    beforeEach(() => {
      jest.clearAllMocks().resetModules();

      WebSocket = require('ws');

      jest.mock('config');
      jest.mock('ws');
      jest.mock('ioredis');

      mockServerWebSocketOn = jest.fn().mockImplementation((_event, cb) => {
        cb(
          JSON.stringify({
            command: 'setting-update',
            data: {
              candles: {
                interval: '2h',
                limit: 40
              }
            }
          })
        );
      });

      mockServerWebSocketSend = jest.fn().mockReturnValue(true);

      mockServerOn = jest.fn().mockImplementation((_event, cb) => {
        cb({
          on: mockServerWebSocketOn,
          send: mockServerWebSocketSend
        });
      });

      WebSocket.Server.mockImplementation(() => ({
        on: mockServerOn
      }));
    });

    describe('when configuration json is invalid', () => {
      beforeEach(() => {
        const { cache, logger } = require('../helpers');
        cacheMock = cache;

        cacheMock.hget = jest.fn().mockImplementation((key, field) => {
          if (
            key === 'simple-stop-chaser-common' &&
            field === 'configuration'
          ) {
            return '';
          }

          return '';
        });

        cacheMock.hset = jest.fn().mockResolvedValue();

        const { runWebSocket } = require('../server-websocket');
        runWebSocket(logger);
      });

      it('does not trigger hset', () => {
        expect(cacheMock.hset).not.toHaveBeenCalled();
      });
    });

    describe('when configuration json is valid', () => {
      beforeEach(() => {
        const { cache, logger } = require('../helpers');
        cacheMock = cache;

        cacheMock.hget = jest.fn().mockImplementation((key, field) => {
          if (
            key === 'simple-stop-chaser-common' &&
            field === 'configuration'
          ) {
            return JSON.stringify({
              candles: {
                interval: '1d',
                limit: 20
              }
            });
          }

          return '';
        });

        cacheMock.hset = jest.fn().mockResolvedValue();

        const { runWebSocket } = require('../server-websocket');
        runWebSocket(logger);
      });

      it('triggers hset', () => {
        expect(cacheMock.hset).toHaveBeenCalledWith(
          'simple-stop-chaser-common',
          'configuration',
          JSON.stringify({
            candles: {
              interval: '2h',
              limit: 40
            }
          })
        );
      });
    });
  });
});
