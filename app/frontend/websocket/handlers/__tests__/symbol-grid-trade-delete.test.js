/* eslint-disable global-require */

describe('symbol-grid-trade-delete.test.js', () => {
  let mockWebSocketServer;
  let mockWebSocketServerWebSocketSend;

  let mockLogger;
  let mockSlack;

  let mockExecute;

  let mockArchiveSymbolGridTrade;
  let mockDeleteSymbolGridTrade;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();

    // Mock moment to return static date
    jest.mock(
      'moment',
      () => nextCheck =>
        jest.requireActual('moment')(nextCheck || '2020-01-02T00:00:00.000Z')
    );

    // Mock moment to return static date
    jest.mock(
      'moment-timezone',
      () => nextCheck =>
        jest.requireActual('moment')(nextCheck || '2020-01-02T00:00:00.000Z')
    );

    mockWebSocketServerWebSocketSend = jest.fn().mockResolvedValue(true);

    mockWebSocketServer = {
      send: mockWebSocketServerWebSocketSend
    };

    mockExecute = jest.fn((funcLogger, symbol, jobPayload) => {
      if (!funcLogger || !symbol || !jobPayload) return false;
      return jobPayload.preprocessFn();
    });

    jest.mock('../../../../cronjob/trailingTradeHelper/queue', () => ({
      execute: mockExecute
    }));
  });

  describe('when symbol is provided', () => {
    describe('action is archive - symbol grid trade exists and it is profit', () => {
      beforeEach(async () => {
        const { logger, slack } = require('../../../../helpers');
        mockLogger = logger;
        mockLogger.fields = { correlationId: 'correlationId' };
        mockSlack = slack;

        mockSlack.sendMessage = jest.fn().mockResolvedValue(true);

        mockArchiveSymbolGridTrade = jest.fn().mockResolvedValue({
          profit: 10,
          profitPercentage: 0.1,
          totalBuyQuoteQty: 100,
          totalSellQuoteQty: 110
        });
        mockDeleteSymbolGridTrade = jest.fn().mockResolvedValue(true);

        jest.mock(
          '../../../../cronjob/trailingTradeHelper/configuration',
          () => ({
            archiveSymbolGridTrade: mockArchiveSymbolGridTrade,
            deleteSymbolGridTrade: mockDeleteSymbolGridTrade
          })
        );

        const {
          handleSymbolGridTradeDelete
        } = require('../symbol-grid-trade-delete');
        await handleSymbolGridTradeDelete(mockLogger, mockWebSocketServer, {
          data: {
            symbol: 'BTCUSDT',
            action: 'archive'
          }
        });
      });

      it('triggers archiveSymbolGridTrade', () => {
        expect(mockArchiveSymbolGridTrade).toHaveBeenCalledWith(
          mockLogger,
          'BTCUSDT'
        );
      });

      it('triggers slack.sendMessage', () => {
        expect(mockSlack.sendMessage).toHaveBeenCalledWith(
          expect.stringContaining('*BTCUSDT* Profit'),
          {
            apiLimit: 0,
            symbol: 'BTCUSDT'
          }
        );
      });

      it('triggers deleteSymbolGridTrade', () => {
        expect(mockDeleteSymbolGridTrade).toHaveBeenCalledWith(
          mockLogger,
          'BTCUSDT'
        );
      });

      it('triggers queue.execute', () => {
        expect(mockExecute).toHaveBeenCalledWith(mockLogger, 'BTCUSDT', {
          correlationId: 'correlationId',
          preprocessFn: expect.any(Function),
          processFn: expect.any(Function)
        });
      });

      it('triggers ws.send', () => {
        expect(mockWebSocketServerWebSocketSend).toHaveBeenCalledWith(
          JSON.stringify({
            result: true,
            type: 'symbol-grid-trade-delete-result'
          })
        );
      });
    });

    describe('action is archive - symbol grid trade exists and it is loss', () => {
      beforeEach(async () => {
        const { logger, slack } = require('../../../../helpers');
        mockLogger = logger;
        mockLogger.fields = { correlationId: 'correlationId' };
        mockSlack = slack;

        mockSlack.sendMessage = jest.fn().mockResolvedValue(true);

        mockArchiveSymbolGridTrade = jest.fn().mockResolvedValue({
          profit: -10,
          profitPercentage: -0.1,
          totalBuyQuoteQty: 110,
          totalSellQuoteQty: 100
        });
        mockDeleteSymbolGridTrade = jest.fn().mockResolvedValue(true);

        jest.mock(
          '../../../../cronjob/trailingTradeHelper/configuration',
          () => ({
            archiveSymbolGridTrade: mockArchiveSymbolGridTrade,
            deleteSymbolGridTrade: mockDeleteSymbolGridTrade
          })
        );

        const {
          handleSymbolGridTradeDelete
        } = require('../symbol-grid-trade-delete');
        await handleSymbolGridTradeDelete(mockLogger, mockWebSocketServer, {
          data: {
            symbol: 'BTCUSDT',
            action: 'archive'
          }
        });
      });

      it('triggers archiveSymbolGridTrade', () => {
        expect(mockArchiveSymbolGridTrade).toHaveBeenCalledWith(
          mockLogger,
          'BTCUSDT'
        );
      });

      it('triggers slack.sendMessage', () => {
        expect(mockSlack.sendMessage).toHaveBeenCalledWith(
          expect.stringContaining('*BTCUSDT* Loss'),
          {
            apiLimit: 0,
            symbol: 'BTCUSDT'
          }
        );
      });

      it('triggers deleteSymbolGridTrade', () => {
        expect(mockDeleteSymbolGridTrade).toHaveBeenCalledWith(
          mockLogger,
          'BTCUSDT'
        );
      });

      it('triggers queue.execute', () => {
        expect(mockExecute).toHaveBeenCalledWith(mockLogger, 'BTCUSDT', {
          correlationId: 'correlationId',
          preprocessFn: expect.any(Function),
          processFn: expect.any(Function)
        });
      });

      it('triggers ws.send', () => {
        expect(mockWebSocketServerWebSocketSend).toHaveBeenCalledWith(
          JSON.stringify({
            result: true,
            type: 'symbol-grid-trade-delete-result'
          })
        );
      });
    });

    describe('action is archive - symbol grid trade does not exist', () => {
      beforeEach(async () => {
        const { logger, slack } = require('../../../../helpers');
        mockLogger = logger;
        mockLogger.fields = { correlationId: 'correlationId' };
        mockSlack = slack;

        mockSlack.sendMessage = jest.fn().mockResolvedValue(true);

        mockArchiveSymbolGridTrade = jest.fn().mockResolvedValue({});
        mockDeleteSymbolGridTrade = jest.fn().mockResolvedValue(true);

        jest.mock(
          '../../../../cronjob/trailingTradeHelper/configuration',
          () => ({
            archiveSymbolGridTrade: mockArchiveSymbolGridTrade,
            deleteSymbolGridTrade: mockDeleteSymbolGridTrade
          })
        );

        const {
          handleSymbolGridTradeDelete
        } = require('../symbol-grid-trade-delete');
        await handleSymbolGridTradeDelete(mockLogger, mockWebSocketServer, {
          data: {
            symbol: 'BTCUSDT',
            action: 'archive'
          }
        });
      });

      it('triggers archiveSymbolGridTrade', () => {
        expect(mockArchiveSymbolGridTrade).toHaveBeenCalledWith(
          mockLogger,
          'BTCUSDT'
        );
      });

      it('does not trigger slack.sendMessage', () => {
        expect(mockSlack.sendMessage).not.toHaveBeenCalled();
      });

      it('triggers deleteSymbolGridTrade', () => {
        expect(mockDeleteSymbolGridTrade).toHaveBeenCalledWith(
          mockLogger,
          'BTCUSDT'
        );
      });

      it('triggers queue.execute', () => {
        expect(mockExecute).toHaveBeenCalledWith(mockLogger, 'BTCUSDT', {
          correlationId: 'correlationId',
          preprocessFn: expect.any(Function),
          processFn: expect.any(Function)
        });
      });

      it('triggers ws.send', () => {
        expect(mockWebSocketServerWebSocketSend).toHaveBeenCalledWith(
          JSON.stringify({
            result: true,
            type: 'symbol-grid-trade-delete-result'
          })
        );
      });
    });

    describe('action is delete', () => {
      beforeEach(async () => {
        const { logger, slack } = require('../../../../helpers');
        mockLogger = logger;
        mockLogger.fields = { correlationId: 'correlationId' };
        mockSlack = slack;

        mockSlack.sendMessage = jest.fn().mockResolvedValue(true);

        mockArchiveSymbolGridTrade = jest.fn().mockResolvedValue({});
        mockDeleteSymbolGridTrade = jest.fn().mockResolvedValue(true);

        jest.mock(
          '../../../../cronjob/trailingTradeHelper/configuration',
          () => ({
            archiveSymbolGridTrade: mockArchiveSymbolGridTrade,
            deleteSymbolGridTrade: mockDeleteSymbolGridTrade
          })
        );

        const {
          handleSymbolGridTradeDelete
        } = require('../symbol-grid-trade-delete');
        await handleSymbolGridTradeDelete(mockLogger, mockWebSocketServer, {
          data: {
            symbol: 'BTCUSDT',
            action: 'delete'
          }
        });
      });

      it('does not trigger archiveSymbolGridTrade', () => {
        expect(mockArchiveSymbolGridTrade).not.toHaveBeenCalled();
      });

      it('does not trigger slack.sendMessage', () => {
        expect(mockSlack.sendMessage).not.toHaveBeenCalled();
      });

      it('triggers deleteSymbolGridTrade', () => {
        expect(mockDeleteSymbolGridTrade).toHaveBeenCalledWith(
          mockLogger,
          'BTCUSDT'
        );
      });

      it('triggers queue.execute', () => {
        expect(mockExecute).toHaveBeenCalledWith(mockLogger, 'BTCUSDT', {
          correlationId: 'correlationId',
          preprocessFn: expect.any(Function),
          processFn: expect.any(Function)
        });
      });

      it('triggers ws.send', () => {
        expect(mockWebSocketServerWebSocketSend).toHaveBeenCalledWith(
          JSON.stringify({
            result: true,
            type: 'symbol-grid-trade-delete-result'
          })
        );
      });
    });
  });
});
