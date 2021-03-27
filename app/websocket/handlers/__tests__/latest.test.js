/* eslint-disable global-require */
const _ = require('lodash');

describe('latest.test.js', () => {
  const trailingTradeCommonJson = require('./fixtures/latest-trailing-trade-common.json');
  const trailingTradeSymbols = require('./fixtures/latest-trailing-trade-symbols.json');
  const trailingTradeStats = require('./fixtures/latest-stats.json');

  let mockWebSocketServer;
  let mockWebSocketServerWebSocketSend;

  let cacheMock;
  let mongoMock;

  beforeEach(() => {
    mockWebSocketServerWebSocketSend = jest.fn().mockResolvedValue(true);

    mockWebSocketServer = {
      send: mockWebSocketServerWebSocketSend
    };
  });

  describe('when some cache is invalid', () => {
    beforeEach(async () => {
      const { cache, logger, mongo } = require('../../../helpers');
      cacheMock = cache;
      mongoMock = mongo;

      cacheMock.hgetall = jest.fn().mockImplementation(_key => '');

      mongoMock.findOne = jest
        .fn()
        .mockImplementation((_logger, collection, filter) => {
          if (
            collection === 'trailing-trade-common' &&
            _.isEqual(filter, { key: 'configuration' })
          ) {
            return { enabled: true };
          }

          if (
            collection === 'trailing-trade-symbols' &&
            _.isEqual(filter, { key: 'BNBUSDT-configuration' })
          ) {
            return { enabled: true, symbol: 'BNBUSDT' };
          }
          if (
            collection === 'trailing-trade-symbols' &&
            _.isEqual(filter, { key: 'BNBUSDT-last-buy-price' })
          ) {
            return { lastBuyPrice: null };
          }

          if (
            collection === 'trailing-trade-symbols' &&
            _.isEqual(filter, { key: 'ETHUSDT-configuration' })
          ) {
            return { enabled: true, symbol: 'ETHUSDT' };
          }

          if (
            collection === 'trailing-trade-symbols' &&
            _.isEqual(filter, { key: 'ETHUSDT-last-buy-price' })
          ) {
            return { lastBuyPrice: null };
          }

          return null;
        });

      const { handleLatest } = require('../latest');
      await handleLatest(logger, mockWebSocketServer, {});
    });

    it('does not trigger ws.send', () => {
      expect(mockWebSocketServerWebSocketSend).not.toHaveBeenCalled();
    });
  });

  describe('with valid cache', () => {
    beforeEach(async () => {
      const { cache, logger, mongo } = require('../../../helpers');
      cacheMock = cache;
      mongoMock = mongo;

      cacheMock.hgetall = jest.fn().mockImplementation(key => {
        if (key === 'trailing-trade-common') {
          return trailingTradeCommonJson;
        }

        if (key === 'trailing-trade-symbols') {
          return trailingTradeSymbols;
        }

        return '';
      });

      mongoMock.findOne = jest
        .fn()
        .mockImplementation((_logger, collection, filter) => {
          if (
            collection === 'trailing-trade-common' &&
            _.isEqual(filter, { key: 'configuration' })
          ) {
            return {
              enabled: true,
              type: 'i-am-global',
              candles: { interval: '15m' }
            };
          }

          if (
            collection === 'trailing-trade-symbols' &&
            _.isEqual(filter, { key: 'BNBUSDT-configuration' })
          ) {
            return { enabled: true, symbol: 'BNBUSDT', type: 'i-am-symbol' };
          }
          if (
            collection === 'trailing-trade-symbols' &&
            _.isEqual(filter, { key: 'BNBUSDT-last-buy-price' })
          ) {
            return { lastBuyPrice: null, type: 'i-am-symbol' };
          }

          if (
            collection === 'trailing-trade-symbols' &&
            _.isEqual(filter, { key: 'ETHUSDT-configuration' })
          ) {
            return { enabled: true, symbol: 'ETHUSDT', type: 'i-am-symbol' };
          }

          if (
            collection === 'trailing-trade-symbols' &&
            _.isEqual(filter, { key: 'ETHUSDT-last-buy-price' })
          ) {
            return { lastBuyPrice: null, type: 'i-am-symbol' };
          }

          return null;
        });

      const { handleLatest } = require('../latest');
      await handleLatest(logger, mockWebSocketServer, {});
    });

    it('triggers ws.send with latest', () => {
      expect(mockWebSocketServerWebSocketSend).toHaveBeenCalledWith(
        JSON.stringify(trailingTradeStats)
      );
    });
  });
});
