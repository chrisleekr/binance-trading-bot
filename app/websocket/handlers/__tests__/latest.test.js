/* eslint-disable global-require */

describe('latest.test.js', () => {
  const simpleStopChaserCommonJson = require('./fixtures/latest-simple-stop-chaser-common.json');

  // eslint-disable-next-line max-len
  const simpleStopChaserSymbolsWithSellOrderJson = require('./fixtures/latest-simple-stop-chaser-symbols-with-sell-order.json');
  const simpleStopChaserStatsWithSellOrderJson = require('./fixtures/latest-stats-with-sell-order.json');

  // eslint-disable-next-line max-len
  const simpleStopChaserSymbolsWithBuyOrderJson = require('./fixtures/latest-simple-stop-chaser-symbols-with-buy-order.json');
  const simpleStopChaserStatsWithBuyOrderJson = require('./fixtures/latest-stats-with-buy-order.json');

  let mockWebSocketServer;
  let mockWebSocketServerWebSocketSend;

  let cacheMock;

  beforeEach(() => {
    mockWebSocketServerWebSocketSend = jest.fn().mockResolvedValue(true);

    mockWebSocketServer = {
      send: mockWebSocketServerWebSocketSend
    };
  });

  describe('when there are open orders with sell', () => {
    beforeEach(async () => {
      const { cache, logger } = require('../../../helpers');
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
        if (key === 'simple-stop-chaser-common' && field === 'configuration') {
          return JSON.stringify({ enabled: true });
        }
        return '';
      });

      const { handleLatest } = require('../latest');
      handleLatest(logger, mockWebSocketServer, {});
    });

    it('triggers ws.send with latest', () => {
      expect(mockWebSocketServerWebSocketSend).toHaveBeenCalledWith(
        JSON.stringify(simpleStopChaserStatsWithSellOrderJson)
      );
    });
  });

  describe('when there are open orders with buy', () => {
    beforeEach(async () => {
      const { cache, logger } = require('../../../helpers');
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
        if (key === 'simple-stop-chaser-common' && field === 'configuration') {
          return JSON.stringify({ enabled: true });
        }
        return '';
      });

      const { handleLatest } = require('../latest');
      await handleLatest(logger, mockWebSocketServer, {});
    });

    it('triggers ws.send with latest', () => {
      expect(mockWebSocketServerWebSocketSend).toHaveBeenCalledWith(
        JSON.stringify(simpleStopChaserStatsWithBuyOrderJson)
      );
    });
  });
});
