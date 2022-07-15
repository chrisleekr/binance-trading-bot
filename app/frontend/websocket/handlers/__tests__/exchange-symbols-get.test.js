/* eslint-disable global-require */
describe('exchange-symbols-get.js', () => {
  let mockWebSocketServer;
  let mockWebSocketServerWebSocketSend;

  let loggerMock;
  let cacheMock;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();

    mockWebSocketServerWebSocketSend = jest.fn().mockResolvedValue(true);

    mockWebSocketServer = {
      send: mockWebSocketServerWebSocketSend
    };

    const { cache, logger } = require('../../../../helpers');

    cacheMock = cache;
    loggerMock = logger;
  });

  describe('when got cache successfully', () => {
    beforeEach(async () => {
      cacheMock.hget = jest.fn().mockResolvedValue(
        JSON.stringify({
          some: 'data'
        })
      );

      const { handleExchangeSymbolsGet } = require('../exchange-symbols-get');
      await handleExchangeSymbolsGet(loggerMock, mockWebSocketServer, {});
    });

    it('triggers cache.hget', () => {
      expect(cacheMock.hget).toHaveBeenCalledWith(
        'trailing-trade-common',
        'exchange-symbols'
      );
    });

    it('returns expected value', () => {
      expect(mockWebSocketServerWebSocketSend).toHaveBeenCalledWith(
        JSON.stringify({
          result: true,
          type: 'exchange-symbols-get-result',
          exchangeSymbols: {
            some: 'data'
          }
        })
      );
    });
  });

  describe('when failed to get cache', () => {
    beforeEach(async () => {
      cacheMock.hget = jest.fn().mockResolvedValue(null);

      const { handleExchangeSymbolsGet } = require('../exchange-symbols-get');
      await handleExchangeSymbolsGet(loggerMock, mockWebSocketServer, {});
    });

    it('triggers cache.hget', () => {
      expect(cacheMock.hget).toHaveBeenCalledWith(
        'trailing-trade-common',
        'exchange-symbols'
      );
    });

    it('returns expected value', () => {
      expect(mockWebSocketServerWebSocketSend).toHaveBeenCalledWith(
        JSON.stringify({
          result: true,
          type: 'exchange-symbols-get-result',
          exchangeSymbols: {}
        })
      );
    });
  });
});
