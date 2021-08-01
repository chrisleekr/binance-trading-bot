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

  const mockHandlers = {
    handleLatest: null,
    handleSettingUpdate: null,
    handleSymbolUpdateLastBuyPrice: null,
    handleSymbolDelete: null,
    handleSymbolSettingUpdate: null,
    handleSymbolSettingDelete: null,
    handleSymbolGridTradeDelete: null,
    handleSymbolEnableAction: null,
    handleSymbolTriggerBuy: null,
    handleManualTrade: null,
    handleManualTradeAllSymbols: null,
    handleCancelOrder: null,
    handleDustTransferGet: null,
    handleDustTransferExecute: null
  };

  let PubSubMock;
  let cacheMock;

  let wss;
  let config;
  let jwt;

  let jwtVerifyResult = false;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();

    WebSocket = require('ws');
    config = require('config');
    jwt = require('jsonwebtoken');

    jest.mock('ws');
    jest.mock('config');
    jest.mock('ioredis');
    jest.mock('jsonwebtoken');

    jwt.verify = jest.fn().mockImplementation(() => {
      if (jwtVerifyResult) {
        return {
          test: 'value'
        };
      }
      throw new Error('jwt error');
    });

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

    mockHandlers.handleLatest = jest.fn().mockResolvedValue(true);
    mockHandlers.handleSettingUpdate = jest.fn().mockResolvedValue(true);
    mockHandlers.handleSymbolUpdateLastBuyPrice = jest
      .fn()
      .mockResolvedValue(true);
    mockHandlers.handleSymbolDelete = jest.fn().mockResolvedValue(true);
    mockHandlers.handleSymbolSettingUpdate = jest.fn().mockResolvedValue(true);
    mockHandlers.handleSymbolSettingDelete = jest.fn().mockResolvedValue(true);
    mockHandlers.handleSymbolGridTradeDelete = jest
      .fn()
      .mockResolvedValue(true);
    mockHandlers.handleSymbolEnableAction = jest.fn().mockResolvedValue(true);
    mockHandlers.handleSymbolTriggerBuy = jest.fn().mockResolvedValue(true);
    mockHandlers.handleManualTrade = jest.fn().mockResolvedValue(true);
    mockHandlers.handleManualTradeAllSymbols = jest
      .fn()
      .mockResolvedValue(true);
    mockHandlers.handleCancelOrder = jest.fn().mockResolvedValue(true);
    mockHandlers.handleDustTransferGet = jest.fn().mockResolvedValue(true);
    mockHandlers.handleDustTransferExecute = jest.fn().mockResolvedValue(true);

    jest.mock('../handlers', () => ({
      handleLatest: mockHandlers.handleLatest,
      handleSettingUpdate: mockHandlers.handleSettingUpdate,
      handleSymbolUpdateLastBuyPrice:
        mockHandlers.handleSymbolUpdateLastBuyPrice,
      handleSymbolDelete: mockHandlers.handleSymbolDelete,
      handleSymbolSettingUpdate: mockHandlers.handleSymbolSettingUpdate,
      handleSymbolSettingDelete: mockHandlers.handleSymbolSettingDelete,
      handleSymbolGridTradeDelete: mockHandlers.handleSymbolGridTradeDelete,
      handleSymbolEnableAction: mockHandlers.handleSymbolEnableAction,
      handleSymbolTriggerBuy: mockHandlers.handleSymbolTriggerBuy,
      handleManualTrade: mockHandlers.handleManualTrade,
      handleManualTradeAllSymbols: mockHandlers.handleManualTradeAllSymbols,
      handleCancelOrder: mockHandlers.handleCancelOrder,
      handleDustTransferGet: mockHandlers.handleDustTransferGet,
      handleDustTransferExecute: mockHandlers.handleDustTransferExecute
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
          type: 'notification',
          message: { type: 'warning', title: 'Command is not provided.' }
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
          type: 'notification',
          message: { type: 'warning', title: 'Command is not provided.' }
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
          type: 'notification',
          message: { type: 'warning', title: 'Command is not recognised.' }
        })
      );
    });

    it('returns wss', () => {
      expect(wss).not.toBeNull();
    });
  });

  describe('when message command is latest', () => {
    describe('when authenticated', () => {
      beforeEach(() => {
        jwtVerifyResult = true;

        mockWebSocketServerWebSocketOn = jest
          .fn()
          .mockImplementation((_event, cb) => {
            cb(
              JSON.stringify({
                command: 'latest',
                authToken: 'authToken'
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

        const { logger, PubSub, cache } = require('../../../helpers');

        PubSubMock = PubSub;
        PubSubMock.subscribe = jest.fn().mockImplementation((_event, cb) => {
          cb('my-message', 'my-data');
        });

        cacheMock = cache;
        cacheMock.get = jest.fn().mockReturnValue('jwtSecret');

        const { configureWebSocket } = require('../configure');
        configureWebSocket(mockExpressServer, logger);
      });

      it('triggers jwt.verify', () => {
        expect(jwt.verify).toHaveBeenCalledWith('authToken', 'jwtSecret', {
          algorithm: 'HS256'
        });
      });

      it('triggers handleLatest', () => {
        expect(mockHandlers.handleLatest).toHaveBeenCalledWith(
          expect.any(Object),
          expect.any(Object),
          {
            command: 'latest',
            authToken: 'authToken',
            isAuthenticated: true
          }
        );
      });

      it('returns wss', () => {
        expect(wss).not.toBeNull();
      });
    });

    describe('when is not authenticated', () => {
      beforeEach(() => {
        jwtVerifyResult = false;

        mockWebSocketServerWebSocketOn = jest
          .fn()
          .mockImplementation((_event, cb) => {
            cb(
              JSON.stringify({
                command: 'latest',
                authToken: 'authToken'
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

        const { logger, PubSub, cache } = require('../../../helpers');

        PubSubMock = PubSub;
        PubSubMock.subscribe = jest.fn().mockImplementation((_event, cb) => {
          cb('my-message', 'my-data');
        });

        cacheMock = cache;
        cacheMock.get = jest.fn().mockReturnValue('jwtSecret');

        const { configureWebSocket } = require('../configure');
        configureWebSocket(mockExpressServer, logger);
      });

      it('triggers jwt.verify', () => {
        expect(jwt.verify).toHaveBeenCalledWith('authToken', 'jwtSecret', {
          algorithm: 'HS256'
        });
      });

      it('triggers handleLatest', () => {
        expect(mockHandlers.handleLatest).toHaveBeenCalledWith(
          expect.any(Object),
          expect.any(Object),
          {
            command: 'latest',
            authToken: 'authToken',
            isAuthenticated: false
          }
        );
      });

      it('returns wss', () => {
        expect(wss).not.toBeNull();
      });
    });
  });

  [
    {
      command: 'setting-update',
      commandFunc: 'handleSettingUpdate'
    },
    {
      command: 'symbol-update-last-buy-price',
      commandFunc: 'handleSymbolUpdateLastBuyPrice'
    },
    {
      command: 'symbol-delete',
      commandFunc: 'handleSymbolDelete'
    },
    {
      command: 'symbol-setting-update',
      commandFunc: 'handleSymbolSettingUpdate'
    },
    {
      command: 'symbol-setting-delete',
      commandFunc: 'handleSymbolSettingDelete'
    },
    {
      command: 'symbol-grid-trade-delete',
      commandFunc: 'handleSymbolGridTradeDelete'
    },
    {
      command: 'symbol-enable-action',
      commandFunc: 'handleSymbolEnableAction'
    },
    {
      command: 'symbol-trigger-buy',
      commandFunc: 'handleSymbolTriggerBuy'
    },
    {
      command: 'manual-trade',
      commandFunc: 'handleManualTrade'
    },
    {
      command: 'manual-trade-all-symbols',
      commandFunc: 'handleManualTradeAllSymbols'
    },
    {
      command: 'cancel-order',
      commandFunc: 'handleCancelOrder'
    },
    {
      command: 'dust-transfer-get',
      commandFunc: 'handleDustTransferGet'
    },
    {
      command: 'dust-transfer-execute',
      commandFunc: 'handleDustTransferExecute'
    }
  ].forEach(t => {
    describe(`when message command is ${t.command}`, () => {
      describe('when authenticated', () => {
        beforeEach(() => {
          jwtVerifyResult = true;

          mockWebSocketServerWebSocketOn = jest
            .fn()
            .mockImplementation((_event, cb) => {
              cb(
                JSON.stringify({
                  command: t.command,
                  authToken: 'authToken'
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

          const { logger, PubSub, cache } = require('../../../helpers');

          PubSubMock = PubSub;
          PubSubMock.subscribe = jest.fn().mockImplementation((_event, cb) => {
            cb('my-message', 'my-data');
          });

          cacheMock = cache;
          cacheMock.get = jest.fn().mockReturnValue('jwtSecret');

          const { configureWebSocket } = require('../configure');
          configureWebSocket(mockExpressServer, logger);
        });

        it('triggers jwt.verify', () => {
          expect(jwt.verify).toHaveBeenCalledWith('authToken', 'jwtSecret', {
            algorithm: 'HS256'
          });
        });

        it(`triggers handle function`, () => {
          expect(mockHandlers[t.commandFunc]).toHaveBeenCalledWith(
            expect.any(Object),
            expect.any(Object),
            {
              command: t.command,
              authToken: 'authToken'
            }
          );
        });

        it('returns wss', () => {
          expect(wss).not.toBeNull();
        });
      });

      describe('when is not authenticated', () => {
        beforeEach(() => {
          jwtVerifyResult = false;

          mockWebSocketServerWebSocketOn = jest
            .fn()
            .mockImplementation((_event, cb) => {
              cb(
                JSON.stringify({
                  command: t.command,
                  authToken: 'authToken'
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

          const { logger, PubSub, cache } = require('../../../helpers');

          PubSubMock = PubSub;
          PubSubMock.subscribe = jest.fn().mockImplementation((_event, cb) => {
            cb('my-message', 'my-data');
          });

          cacheMock = cache;
          cacheMock.get = jest.fn().mockReturnValue('jwtSecret');

          const { configureWebSocket } = require('../configure');
          configureWebSocket(mockExpressServer, logger);
        });

        it('triggers jwt.verify', () => {
          expect(jwt.verify).toHaveBeenCalledWith('authToken', 'jwtSecret', {
            algorithm: 'HS256'
          });
        });

        it('does not trigger handle function', () => {
          expect(mockHandlers[t.commandFunc]).not.toHaveBeenCalled();
        });

        it('returns wss', () => {
          expect(wss).not.toBeNull();
        });
      });
    });
  });

  describe('PubSub.subscribe', () => {
    beforeEach(() => {
      jwtVerifyResult = true;

      mockWebSocketServerWebSocketOn = jest
        .fn()
        .mockImplementation((_event, cb) => {
          cb(
            JSON.stringify({
              command: 'cancel-order',
              authToken: 'authToken'
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

      const { logger, PubSub, cache } = require('../../../helpers');

      PubSubMock = PubSub;
      PubSubMock.subscribe = jest.fn().mockImplementation((_event, cb) => {
        cb('my-message', 'my-data');
      });

      cacheMock = cache;
      cacheMock.get = jest.fn().mockReturnValue('jwtSecret');

      const { configureWebSocket } = require('../configure');
      configureWebSocket(mockExpressServer, logger);
    });

    it('triggers handleCancelOrder', () => {
      expect(mockHandlers.handleCancelOrder).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(Object),
        {
          command: 'cancel-order',
          authToken: 'authToken'
        }
      );
    });

    it('triggers PubSubMock.subscribe', () => {
      expect(PubSubMock.subscribe).toHaveBeenCalledWith(
        'frontend-notification',
        expect.any(Function)
      );
    });

    it('triggers ws.send with notification', () => {
      expect(mockWebSocketServerWebSocketSend).toHaveBeenCalledWith(
        JSON.stringify({
          result: true,
          type: 'notification',
          message: 'my-data'
        })
      );
    });

    it('returns wss', () => {
      expect(wss).not.toBeNull();
    });
  });
});
