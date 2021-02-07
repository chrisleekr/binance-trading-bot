/* eslint-disable global-require */
describe('server-websocket', () => {
  let WebSocket;

  let mockServerOn;
  let mockServerWebSocketOn;
  let mockServerWebSocketSend;

  let cacheMock;
  let wss;
  let config;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();
    config = require('config');

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
            }
          };
        default:
          return `value-${key}`;
      }
    });
  });

  describe('when message is not JSON', () => {
    beforeEach(() => {
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

    // eslint-disable-next-line max-len
    const simpleStopChaserSymbolsWithSellOrderJson = require('./fixtures/server-websocket-simple-stop-chaser-symbols-with-sell-order.json');
    const simpleStopChaserStatsWithSellOrderJson = require('./fixtures/server-websocket-stats-with-sell-order.json');

    // eslint-disable-next-line max-len
    const simpleStopChaserSymbolsWithBuyOrderJson = require('./fixtures/server-webscoket-simple-stop-chaser-symbols-with-buy-order.json');
    const simpleStopChaserStatsWithBuyOrderJson = require('./fixtures/server-websocket-stats-with-buy-order.json');

    beforeEach(() => {
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
    });

    describe('when there are open orders with sell', () => {
      beforeEach(async () => {
        const { cache, logger } = require('../helpers');
        cacheMock = cache;

        cacheMock.hgetall = jest.fn().mockImplementation(key => {
          if (key === 'simple-stop-chaser-common') {
            return simpleStopChaserCommonJson;
          }

          if (key === 'simple-stop-chaser-symbols') {
            return simpleStopChaserSymbolsWithSellOrderJson;
          }

          return '';
        });

        cacheMock.hget = jest.fn().mockImplementation((key, field) => {
          if (
            key === 'simple-stop-chaser-common' &&
            field === 'configuration'
          ) {
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
            stats: simpleStopChaserStatsWithSellOrderJson,
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

    describe('when there are open orders with buy', () => {
      beforeEach(async () => {
        const { cache, logger } = require('../helpers');
        cacheMock = cache;

        cacheMock.hgetall = jest.fn().mockImplementation(key => {
          if (key === 'simple-stop-chaser-common') {
            return simpleStopChaserCommonJson;
          }

          if (key === 'simple-stop-chaser-symbols') {
            return simpleStopChaserSymbolsWithBuyOrderJson;
          }

          return '';
        });

        cacheMock.hget = jest.fn().mockImplementation((key, field) => {
          if (
            key === 'simple-stop-chaser-common' &&
            field === 'configuration'
          ) {
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
            stats: simpleStopChaserStatsWithBuyOrderJson,
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
  });

  describe('when message command is setting-update', () => {
    beforeEach(() => {
      WebSocket = require('ws');

      jest.mock('config');
      jest.mock('ws');
      jest.mock('ioredis');

      mockServerWebSocketOn = jest.fn().mockImplementation((_event, cb) => {
        cb(
          JSON.stringify({
            command: 'setting-update',
            data: {
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
                limit: 150
              },
              maxPurchaseAmount: 150,
              stopLossLimit: {
                lastBuyPercentage: 1.1,
                stopPercentage: 0.97,
                limitPercentage: 0.96
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
                'BCHUSDT'
              ],
              candles: {
                interval: '1d',
                limit: 5
              },
              maxPurchaseAmount: 100,
              stopLossLimit: {
                lastBuyPercentage: 1.05,
                stopPercentage: 0.98,
                limitPercentage: 0.97
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
            candles: { interval: '15m', limit: 150 },
            maxPurchaseAmount: 150,
            stopLossLimit: {
              lastBuyPercentage: 1.1,
              stopPercentage: 0.97,
              limitPercentage: 0.96
            }
          })
        );
      });
    });
  });

  describe('when message command is symbol-delete', () => {
    beforeEach(() => {
      jest.clearAllMocks().resetModules();

      WebSocket = require('ws');

      jest.mock('config');
      jest.mock('ws');
      jest.mock('ioredis');

      mockServerWebSocketOn = jest.fn().mockImplementation((_event, cb) => {
        cb(
          JSON.stringify({
            command: 'symbol-delete',
            data: {
              symbolInfo: {
                symbol: 'BTCUSDT'
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

    describe('when there is no cache starting with BTCUSDT', () => {
      beforeEach(() => {
        const { cache, logger } = require('../helpers');
        cacheMock = cache;

        cacheMock.hgetall = jest.fn().mockImplementation(key => {
          if (key === 'simple-stop-chaser-symbols') {
            return {
              'LTCUSDT-some-key': 'some-value',
              'QTUMUSDT-some-key': 'some-value'
            };
          }

          return '';
        });

        cacheMock.hdel = jest.fn().mockResolvedValue();

        const { runWebSocket } = require('../server-websocket');
        runWebSocket(logger);
      });

      it('does not trigger cache.hdel', () => {
        expect(cacheMock.hdel).not.toHaveBeenCalled();
      });
    });

    describe('when there is cache starting with BTCUSDT', () => {
      beforeEach(() => {
        const { cache, logger } = require('../helpers');
        cacheMock = cache;

        cacheMock.hgetall = jest.fn().mockImplementation(key => {
          if (key === 'simple-stop-chaser-symbols') {
            return {
              'LTCUSDT-some-key': 'some-value',
              'BTCUSDT-some-key1': 'some-value',
              'QTUMUSDT-some-key': 'some-value',
              'BTCUSDT-some-key2': 'some-value'
            };
          }

          return '';
        });

        cacheMock.hdel = jest.fn().mockResolvedValue();

        const { runWebSocket } = require('../server-websocket');
        runWebSocket(logger);
      });

      it('triggers cache.hdel', () => {
        expect(cacheMock.hdel).toHaveBeenCalledWith(
          'simple-stop-chaser-symbols',
          'BTCUSDT-some-key1'
        );
        expect(cacheMock.hdel).toHaveBeenCalledWith(
          'simple-stop-chaser-symbols',
          'BTCUSDT-some-key2'
        );
      });
    });
  });
});
