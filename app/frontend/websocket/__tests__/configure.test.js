/* eslint-disable global-require */

describe('websocket/configure.js', () => {
  let WebSocket;

  let mockExpressServer;
  let mockExpressServerOn;

  let mockWebSocketServerOn;
  let mockWebSocketServerWebSocketOn;
  let mockWebSocketServerWebSocketSend;
  let mockWebSocketServerHandleUpgrade;
  let mockWebSocketServerEmit;

  let mockHandleLatest;
  let mockHandleSettingUpdate;
  let mockHandleSymbolUpdate;
  let mockHandleSymbolDelete;
  let mockHandleSymbolSettingUpdate;
  let mockHandleSymbolSettingDelete;
  let mockHandleSymbolEnableAction;

  let wss;
  let config;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();

    WebSocket = require('ws');
    config = require('config');

    jest.mock('ws');
    jest.mock('config');
    jest.mock('ioredis');

    config.get = jest.fn(key => {
      switch (key) {
        case 'mode':
          return 'test';
        case 'jobs.simpleStopChaser':
          return {
            enabled: true,
            cronTime: '* * * * * *',
            symbols: [
              'BTCUSDT',
              'ETHUSDT',
              'LTCUSDT',
              'XRPUSDT',
              'LINKUSDT',
              'BNBUSDT',
              'EOSUSDT',
              'TRXUSDT',
              'XLMUSDT',
              'BCHUSDT',
              'DOTUSDT',
              'ADAUSDT'
            ],
            candles: {
              interval: '15m',
              limit: 200
            },
            maxPurchaseAmount: 100,
            stopLossLimit: {
              lastBuyPercentage: 1.06,
              stopPercentage: 0.97,
              limitPercentage: 0.96
            },
            buy: {
              enabled: true
            },
            sell: {
              enabled: true
            }
          };
        default:
          return `value-${key}`;
      }
    });

    mockHandleLatest = jest.fn().mockResolvedValue(true);
    mockHandleSettingUpdate = jest.fn().mockResolvedValue(true);
    mockHandleSymbolUpdate = jest.fn().mockResolvedValue(true);
    mockHandleSymbolDelete = jest.fn().mockResolvedValue(true);
    mockHandleSymbolSettingUpdate = jest.fn().mockResolvedValue(true);
    mockHandleSymbolSettingDelete = jest.fn().mockResolvedValue(true);
    mockHandleSymbolEnableAction = jest.fn().mockResolvedValue(true);

    jest.mock('../handlers', () => ({
      handleLatest: mockHandleLatest,
      handleSettingUpdate: mockHandleSettingUpdate,
      handleSymbolUpdate: mockHandleSymbolUpdate,
      handleSymbolDelete: mockHandleSymbolDelete,
      handleSymbolSettingUpdate: mockHandleSymbolSettingUpdate,
      handleSymbolSettingDelete: mockHandleSymbolSettingDelete,
      handleSymbolEnableAction: mockHandleSymbolEnableAction
    }));

    mockExpressServerOn = jest.fn().mockImplementation((_event, cb) => {
      cb();
    });

    mockExpressServer = {
      on: mockExpressServerOn
    };

    mockWebSocketServerHandleUpgrade = jest
      .fn()
      .mockImplementation((_request, _socket, _head, cb) => {
        cb();
      });

    mockWebSocketServerEmit = jest.fn().mockReturnValue(true);
  });

  describe('when message is not JSON', () => {
    beforeEach(() => {
      mockWebSocketServerWebSocketOn = jest
        .fn()
        .mockImplementation((_event, cb) => {
          cb('not-json');
        });

      mockWebSocketServerWebSocketSend = jest.fn().mockReturnValue(true);

      mockWebSocketServerOn = jest.fn().mockImplementation((_event, cb) => {
        cb({
          on: mockWebSocketServerWebSocketOn,
          send: mockWebSocketServerWebSocketSend
        });
      });

      WebSocket.Server.mockImplementation(() => ({
        on: mockWebSocketServerOn,
        handleUpgrade: mockWebSocketServerHandleUpgrade,
        emit: mockWebSocketServerEmit
      }));
      const { logger } = require('../../../helpers');

      const { configureWebSocket } = require('../configure');
      configureWebSocket(mockExpressServer, logger);
    });

    it('triggers WebSocket.Server', () => {
      expect(WebSocket.Server).toHaveBeenCalledWith({ noServer: true });
    });

    it('triggers ws.send with connection_success', () => {
      expect(mockWebSocketServerWebSocketSend).toHaveBeenCalledWith(
        JSON.stringify({
          result: true,
          type: 'connection_success',
          message: 'You are successfully connected to WebSocket.'
        })
      );
    });

    it('triggers ws.send with error', () => {
      expect(mockWebSocketServerWebSocketSend).toHaveBeenCalledWith(
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
      mockWebSocketServerWebSocketOn = jest
        .fn()
        .mockImplementation((_event, cb) => {
          cb(
            JSON.stringify({
              noCommand: 'here'
            })
          );
        });

      mockWebSocketServerWebSocketSend = jest.fn().mockReturnValue(true);

      mockWebSocketServerOn = jest.fn().mockImplementation((_event, cb) => {
        cb({
          on: mockWebSocketServerWebSocketOn,
          send: mockWebSocketServerWebSocketSend
        });
      });

      WebSocket.Server.mockImplementation(() => ({
        on: mockWebSocketServerOn,
        handleUpgrade: mockWebSocketServerHandleUpgrade,
        emit: mockWebSocketServerEmit
      }));

      const { logger } = require('../../../helpers');

      const { configureWebSocket } = require('../configure');
      configureWebSocket(mockExpressServer, logger);
    });

    it('triggers ws.send with connection_success', () => {
      expect(mockWebSocketServerWebSocketSend).toHaveBeenCalledWith(
        JSON.stringify({
          result: true,
          type: 'connection_success',
          message: 'You are successfully connected to WebSocket.'
        })
      );
    });

    it('triggers ws.send with error', () => {
      expect(mockWebSocketServerWebSocketSend).toHaveBeenCalledWith(
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
      mockWebSocketServerWebSocketOn = jest
        .fn()
        .mockImplementation((_event, cb) => {
          cb(
            JSON.stringify({
              command: 'no-valid'
            })
          );
        });

      mockWebSocketServerWebSocketSend = jest.fn().mockReturnValue(true);

      mockWebSocketServerOn = jest.fn().mockImplementation((_event, cb) => {
        cb({
          on: mockWebSocketServerWebSocketOn,
          send: mockWebSocketServerWebSocketSend
        });
      });

      WebSocket.Server.mockImplementation(() => ({
        on: mockWebSocketServerOn,
        handleUpgrade: mockWebSocketServerHandleUpgrade,
        emit: mockWebSocketServerEmit
      }));

      const { logger } = require('../../../helpers');

      const { configureWebSocket } = require('../configure');
      configureWebSocket(mockExpressServer, logger);
    });

    it('triggers ws.send with connection_success', () => {
      expect(mockWebSocketServerWebSocketSend).toHaveBeenCalledWith(
        JSON.stringify({
          result: true,
          type: 'connection_success',
          message: 'You are successfully connected to WebSocket.'
        })
      );
    });

    it('triggers ws.send with error', () => {
      expect(mockWebSocketServerWebSocketSend).toHaveBeenCalledWith(
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
    beforeEach(() => {
      mockWebSocketServerWebSocketOn = jest
        .fn()
        .mockImplementation((_event, cb) => {
          cb(
            JSON.stringify({
              command: 'latest'
            })
          );
        });

      mockWebSocketServerWebSocketSend = jest.fn().mockReturnValue(true);

      mockWebSocketServerOn = jest.fn().mockImplementation((_event, cb) => {
        cb({
          on: mockWebSocketServerWebSocketOn,
          send: mockWebSocketServerWebSocketSend
        });
      });

      WebSocket.Server.mockImplementation(() => ({
        on: mockWebSocketServerOn,
        handleUpgrade: mockWebSocketServerHandleUpgrade,
        emit: mockWebSocketServerEmit
      }));

      const { logger } = require('../../../helpers');

      const { configureWebSocket } = require('../configure');
      configureWebSocket(mockExpressServer, logger);
    });

    it('triggers handleLatest', () => {
      expect(mockHandleLatest).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(Object),
        {
          command: 'latest'
        }
      );
    });

    it('returns wss', () => {
      expect(wss).not.toBeNull();
    });
  });

  describe('when message command is setting-update', () => {
    beforeEach(() => {
      mockWebSocketServerWebSocketOn = jest
        .fn()
        .mockImplementation((_event, cb) => {
          cb(
            JSON.stringify({
              command: 'setting-update'
            })
          );
        });

      mockWebSocketServerWebSocketSend = jest.fn().mockReturnValue(true);

      mockWebSocketServerOn = jest.fn().mockImplementation((_event, cb) => {
        cb({
          on: mockWebSocketServerWebSocketOn,
          send: mockWebSocketServerWebSocketSend
        });
      });

      WebSocket.Server.mockImplementation(() => ({
        on: mockWebSocketServerOn,
        handleUpgrade: mockWebSocketServerHandleUpgrade,
        emit: mockWebSocketServerEmit
      }));

      const { logger } = require('../../../helpers');

      const { configureWebSocket } = require('../configure');
      configureWebSocket(mockExpressServer, logger);
    });

    it('triggers handleSettingUpdate', () => {
      expect(mockHandleSettingUpdate).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(Object),
        {
          command: 'setting-update'
        }
      );
    });

    it('returns wss', () => {
      expect(wss).not.toBeNull();
    });
  });

  describe('when message command is symbol-update', () => {
    beforeEach(() => {
      mockWebSocketServerWebSocketOn = jest
        .fn()
        .mockImplementation((_event, cb) => {
          cb(
            JSON.stringify({
              command: 'symbol-update'
            })
          );
        });

      mockWebSocketServerWebSocketSend = jest.fn().mockReturnValue(true);

      mockWebSocketServerOn = jest.fn().mockImplementation((_event, cb) => {
        cb({
          on: mockWebSocketServerWebSocketOn,
          send: mockWebSocketServerWebSocketSend
        });
      });

      WebSocket.Server.mockImplementation(() => ({
        on: mockWebSocketServerOn,
        handleUpgrade: mockWebSocketServerHandleUpgrade,
        emit: mockWebSocketServerEmit
      }));

      const { logger } = require('../../../helpers');

      const { configureWebSocket } = require('../configure');
      configureWebSocket(mockExpressServer, logger);
    });

    it('triggers handleSymbolUpdate', () => {
      expect(mockHandleSymbolUpdate).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(Object),
        {
          command: 'symbol-update'
        }
      );
    });

    it('returns wss', () => {
      expect(wss).not.toBeNull();
    });
  });

  describe('when message command is symbol-delete', () => {
    beforeEach(() => {
      mockWebSocketServerWebSocketOn = jest
        .fn()
        .mockImplementation((_event, cb) => {
          cb(
            JSON.stringify({
              command: 'symbol-delete'
            })
          );
        });

      mockWebSocketServerWebSocketSend = jest.fn().mockReturnValue(true);

      mockWebSocketServerOn = jest.fn().mockImplementation((_event, cb) => {
        cb({
          on: mockWebSocketServerWebSocketOn,
          send: mockWebSocketServerWebSocketSend
        });
      });

      WebSocket.Server.mockImplementation(() => ({
        on: mockWebSocketServerOn,
        handleUpgrade: mockWebSocketServerHandleUpgrade,
        emit: mockWebSocketServerEmit
      }));

      const { logger } = require('../../../helpers');

      const { configureWebSocket } = require('../configure');
      configureWebSocket(mockExpressServer, logger);
    });

    it('triggers handleSymbolDelete', () => {
      expect(mockHandleSymbolDelete).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(Object),
        {
          command: 'symbol-delete'
        }
      );
    });

    it('returns wss', () => {
      expect(wss).not.toBeNull();
    });
  });

  describe('when message command is symbol-setting-update', () => {
    beforeEach(() => {
      mockWebSocketServerWebSocketOn = jest
        .fn()
        .mockImplementation((_event, cb) => {
          cb(
            JSON.stringify({
              command: 'symbol-setting-update'
            })
          );
        });

      mockWebSocketServerWebSocketSend = jest.fn().mockReturnValue(true);

      mockWebSocketServerOn = jest.fn().mockImplementation((_event, cb) => {
        cb({
          on: mockWebSocketServerWebSocketOn,
          send: mockWebSocketServerWebSocketSend
        });
      });

      WebSocket.Server.mockImplementation(() => ({
        on: mockWebSocketServerOn,
        handleUpgrade: mockWebSocketServerHandleUpgrade,
        emit: mockWebSocketServerEmit
      }));

      const { logger } = require('../../../helpers');

      const { configureWebSocket } = require('../configure');
      configureWebSocket(mockExpressServer, logger);
    });

    it('triggers handleSymbolSettingUpdate', () => {
      expect(mockHandleSymbolSettingUpdate).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(Object),
        {
          command: 'symbol-setting-update'
        }
      );
    });

    it('returns wss', () => {
      expect(wss).not.toBeNull();
    });
  });

  describe('when message command is symbol-setting-delete', () => {
    beforeEach(() => {
      mockWebSocketServerWebSocketOn = jest
        .fn()
        .mockImplementation((_event, cb) => {
          cb(
            JSON.stringify({
              command: 'symbol-setting-delete'
            })
          );
        });

      mockWebSocketServerWebSocketSend = jest.fn().mockReturnValue(true);

      mockWebSocketServerOn = jest.fn().mockImplementation((_event, cb) => {
        cb({
          on: mockWebSocketServerWebSocketOn,
          send: mockWebSocketServerWebSocketSend
        });
      });

      WebSocket.Server.mockImplementation(() => ({
        on: mockWebSocketServerOn,
        handleUpgrade: mockWebSocketServerHandleUpgrade,
        emit: mockWebSocketServerEmit
      }));

      const { logger } = require('../../../helpers');

      const { configureWebSocket } = require('../configure');
      configureWebSocket(mockExpressServer, logger);
    });

    it('triggers handleSymbolSettingDelete', () => {
      expect(mockHandleSymbolSettingDelete).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(Object),
        {
          command: 'symbol-setting-delete'
        }
      );
    });

    it('returns wss', () => {
      expect(wss).not.toBeNull();
    });
  });

  describe('when message command is symbol-enable-action', () => {
    beforeEach(() => {
      mockWebSocketServerWebSocketOn = jest
        .fn()
        .mockImplementation((_event, cb) => {
          cb(
            JSON.stringify({
              command: 'symbol-enable-action'
            })
          );
        });

      mockWebSocketServerWebSocketSend = jest.fn().mockReturnValue(true);

      mockWebSocketServerOn = jest.fn().mockImplementation((_event, cb) => {
        cb({
          on: mockWebSocketServerWebSocketOn,
          send: mockWebSocketServerWebSocketSend
        });
      });

      WebSocket.Server.mockImplementation(() => ({
        on: mockWebSocketServerOn,
        handleUpgrade: mockWebSocketServerHandleUpgrade,
        emit: mockWebSocketServerEmit
      }));

      const { logger } = require('../../../helpers');

      const { configureWebSocket } = require('../configure');
      configureWebSocket(mockExpressServer, logger);
    });

    it('triggers handleSymbolEnableAction', () => {
      expect(mockHandleSymbolEnableAction).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(Object),
        {
          command: 'symbol-enable-action'
        }
      );
    });

    it('returns wss', () => {
      expect(wss).not.toBeNull();
    });
  });
});
