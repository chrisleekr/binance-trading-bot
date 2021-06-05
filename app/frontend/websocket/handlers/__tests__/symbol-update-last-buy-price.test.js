/* eslint-disable global-require */

describe('symbol-update-last-buy-price.test.js', () => {
  let mockWebSocketServer;
  let mockWebSocketServerWebSocketSend;

  let mockGetAccountInfo;
  let mockSaveLastBuyPrice;

  let loggerMock;
  let mongoMock;
  let cacheMock;
  let PubSubMock;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();

    mockWebSocketServerWebSocketSend = jest.fn().mockResolvedValue(true);

    mockWebSocketServer = {
      send: mockWebSocketServerWebSocketSend
    };
  });

  describe('update symbol last buy price', () => {
    describe('when last buy price is less or equal than 0', () => {
      beforeEach(async () => {
        const { mongo, logger, PubSub } = require('../../../../helpers');
        mongoMock = mongo;
        loggerMock = logger;
        PubSubMock = PubSub;

        mongoMock.deleteOne = jest.fn().mockResolvedValue(true);
        PubSubMock.publish = jest.fn().mockResolvedValue(true);

        const {
          handleSymbolUpdateLastBuyPrice
        } = require('../symbol-update-last-buy-price');
        await handleSymbolUpdateLastBuyPrice(logger, mockWebSocketServer, {
          data: {
            symbol: 'BTCUSDT',
            sell: {
              lastBuyPrice: 0
            }
          }
        });
      });

      it('triggers mongo.deleteOne', () => {
        expect(mongoMock.deleteOne).toHaveBeenCalledWith(
          loggerMock,
          'trailing-trade-symbols',
          { key: 'BTCUSDT-last-buy-price' }
        );
      });

      it('triggers PubSub.publish', () => {
        expect(PubSubMock.publish).toHaveBeenCalledWith(
          'frontend-notification',
          {
            type: 'success',
            title:
              'The last buy price for BTCUSDT has been removed successfully.'
          }
        );
      });

      it('triggers ws.send', () => {
        expect(mockWebSocketServerWebSocketSend).toHaveBeenCalledWith(
          JSON.stringify({
            result: true,
            type: 'symbol-update-result',
            message:
              'The last buy price for BTCUSDT has been removed successfully.'
          })
        );
      });
    });

    describe('when last buy price is more than 0', () => {
      describe('when there is no cached symbol info', () => {
        beforeEach(async () => {
          const {
            cache,
            mongo,
            logger,
            PubSub
          } = require('../../../../helpers');
          mongoMock = mongo;
          loggerMock = logger;
          PubSubMock = PubSub;
          cacheMock = cache;

          cacheMock.hget = jest.fn().mockResolvedValue(null);
          PubSubMock.publish = jest.fn().mockResolvedValue(true);

          const {
            handleSymbolUpdateLastBuyPrice
          } = require('../symbol-update-last-buy-price');
          await handleSymbolUpdateLastBuyPrice(logger, mockWebSocketServer, {
            data: {
              symbol: 'BTCUSDT',
              sell: {
                lastBuyPrice: 100
              }
            }
          });
        });

        it('triggers PubSub.publish', () => {
          expect(PubSubMock.publish).toHaveBeenCalledWith(
            'frontend-notification',
            {
              type: 'error',
              title:
                `The bot could not retrieve the cached symbol information for BTCUSDT.` +
                ` Wait for the symbol information to be cached and try again.`
            }
          );
        });

        it('triggers ws.send', () => {
          expect(mockWebSocketServerWebSocketSend).toHaveBeenCalledWith(
            JSON.stringify({
              result: false,
              type: 'symbol-update-last-buy-price-result',
              message:
                `The bot could not retrieve the cached symbol information for BTCUSDT.` +
                ` Wait for the symbol information to be cached and try again.`
            })
          );
        });
      });

      describe('when there is cached symbol info', () => {
        describe('when asset is in balance', () => {
          beforeEach(async () => {
            const { cache, logger, PubSub } = require('../../../../helpers');
            loggerMock = logger;
            PubSubMock = PubSub;
            cacheMock = cache;

            cacheMock.hget = jest.fn().mockImplementation((key, field) => {
              if (
                key === 'trailing-trade-symbols' &&
                field === 'BTCUSDT-symbol-info'
              ) {
                return JSON.stringify({
                  baseAsset: 'BTC'
                });
              }
              return null;
            });

            PubSubMock.publish = jest.fn().mockResolvedValue(true);

            mockGetAccountInfo = jest.fn().mockResolvedValue({
              balances: [
                {
                  asset: 'BTC',
                  free: '100',
                  locked: '50'
                }
              ]
            });

            mockSaveLastBuyPrice = jest.fn().mockResolvedValue(true);

            jest.mock('../../../../cronjob/trailingTradeHelper/common', () => ({
              getAccountInfo: mockGetAccountInfo,
              saveLastBuyPrice: mockSaveLastBuyPrice
            }));

            const {
              handleSymbolUpdateLastBuyPrice
            } = require('../symbol-update-last-buy-price');
            await handleSymbolUpdateLastBuyPrice(
              loggerMock,
              mockWebSocketServer,
              {
                data: {
                  symbol: 'BTCUSDT',
                  sell: {
                    lastBuyPrice: 100
                  }
                }
              }
            );
          });

          it('triggers saveLastBuyPrice', () => {
            expect(mockSaveLastBuyPrice).toHaveBeenCalledWith(
              loggerMock,
              'BTCUSDT',
              {
                lastBuyPrice: 100,
                quantity: 150
              }
            );
          });

          it('triggers PubSub.publish', () => {
            expect(PubSubMock.publish).toHaveBeenCalledWith(
              'frontend-notification',
              {
                type: 'success',
                title: `The last buy price for BTCUSDT has been configured successfully.`
              }
            );
          });

          it('triggers ws.send', () => {
            expect(mockWebSocketServerWebSocketSend).toHaveBeenCalledWith(
              JSON.stringify({
                result: true,
                type: 'symbol-update-result',
                message: `The last buy price for BTCUSDT has been configured successfully.`
              })
            );
          });
        });

        describe('when asset is not in balance', () => {
          beforeEach(async () => {
            const { cache, logger, PubSub } = require('../../../../helpers');
            loggerMock = logger;
            PubSubMock = PubSub;
            cacheMock = cache;

            cacheMock.hget = jest.fn().mockImplementation((key, field) => {
              if (
                key === 'trailing-trade-symbols' &&
                field === 'BTCUSDT-symbol-info'
              ) {
                return JSON.stringify({
                  baseAsset: 'BTC'
                });
              }
              return null;
            });

            PubSubMock.publish = jest.fn().mockResolvedValue(true);

            mockGetAccountInfo = jest.fn().mockResolvedValue({
              balances: [
                {
                  asset: 'BNB',
                  free: '100',
                  locked: '50'
                }
              ]
            });

            mockSaveLastBuyPrice = jest.fn().mockResolvedValue(true);

            jest.mock('../../../../cronjob/trailingTradeHelper/common', () => ({
              getAccountInfo: mockGetAccountInfo,
              saveLastBuyPrice: mockSaveLastBuyPrice
            }));

            const {
              handleSymbolUpdateLastBuyPrice
            } = require('../symbol-update-last-buy-price');
            await handleSymbolUpdateLastBuyPrice(
              loggerMock,
              mockWebSocketServer,
              {
                data: {
                  symbol: 'BTCUSDT',
                  sell: {
                    lastBuyPrice: 100
                  }
                }
              }
            );
          });

          it('triggers saveLastBuyPrice', () => {
            expect(mockSaveLastBuyPrice).toHaveBeenCalledWith(
              loggerMock,
              'BTCUSDT',
              {
                lastBuyPrice: 100,
                quantity: 0
              }
            );
          });

          it('triggers PubSub.publish', () => {
            expect(PubSubMock.publish).toHaveBeenCalledWith(
              'frontend-notification',
              {
                type: 'success',
                title: `The last buy price for BTCUSDT has been configured successfully.`
              }
            );
          });

          it('triggers ws.send', () => {
            expect(mockWebSocketServerWebSocketSend).toHaveBeenCalledWith(
              JSON.stringify({
                result: true,
                type: 'symbol-update-result',
                message: `The last buy price for BTCUSDT has been configured successfully.`
              })
            );
          });
        });
      });
    });
  });
});
