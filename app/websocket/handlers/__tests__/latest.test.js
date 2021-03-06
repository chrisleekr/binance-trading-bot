/* eslint-disable global-require */
const _ = require('lodash');

describe('latest.test.js', () => {
  const simpleStopChaserCommonJson = require('./fixtures/latest-simple-stop-chaser-common.json');

  // eslint-disable-next-line max-len
  const simpleStopChaserSymbols = require('./fixtures/latest-simple-stop-chaser-symbols.json');
  const simpleStopChaserStats = require('./fixtures/latest-stats.json');

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
            collection === 'simple-stop-chaser-common' &&
            _.isEqual(filter, { key: 'configuration' })
          ) {
            return { enabled: true };
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
        if (key === 'simple-stop-chaser-common') {
          return simpleStopChaserCommonJson;
        }

        if (key === 'simple-stop-chaser-symbols') {
          return simpleStopChaserSymbols;
        }

        return '';
      });

      mongoMock.findOne = jest
        .fn()
        .mockImplementation((_logger, collection, filter) => {
          if (
            collection === 'simple-stop-chaser-common' &&
            _.isEqual(filter, { key: 'configuration' })
          ) {
            return { enabled: true, candles: { interval: '15m' } };
          }

          if (
            collection === 'simple-stop-chaser-symbols' &&
            _.isEqual(filter, { key: 'ETHUSDT-configuration' })
          ) {
            return { enabled: true, candles: { interval: '1h' } };
          }

          if (
            collection === 'simple-stop-chaser-symbols' &&
            _.isEqual(filter, { key: 'LTCUSDT-last-buy-price' })
          ) {
            return { lastBuyPrice: 135.555 };
          }

          if (
            collection === 'simple-stop-chaser-symbols' &&
            _.isEqual(filter, { key: 'BTCUSDT-last-buy-price' })
          ) {
            return { lastBuyPrice: 43300.35 };
          }
          return null;
        });

      const { handleLatest } = require('../latest');
      await handleLatest(logger, mockWebSocketServer, {});
    });

    it('triggers ws.send with latest', () => {
      expect(mockWebSocketServerWebSocketSend).toHaveBeenCalledWith(
        JSON.stringify(simpleStopChaserStats)
      );
    });
  });
});
