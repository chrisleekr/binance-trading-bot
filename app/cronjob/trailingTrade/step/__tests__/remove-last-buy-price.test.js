/* eslint-disable global-require */

describe('remove-last-buy-price.js', () => {
  let result;
  let rawData;

  let PubSubMock;
  let slackMock;
  let binanceMock;
  let loggerMock;

  let mockGetAPILimit;
  let mockIsActionDisabled;
  let mockRemoveLastBuyPrice;
  let mockSaveOrderStats;
  let mockSaveOverrideAction;
  let mockGetAndCacheOpenOrdersForSymbol;

  let mockArchiveSymbolGridTrade;
  let mockDeleteSymbolGridTrade;
  let mockGetSymbolGridTrade;

  let mockGetGridTradeOrder;

  describe('execute', () => {
    beforeEach(() => {
      jest.clearAllMocks().resetModules();
    });

    beforeEach(async () => {
      const { PubSub, slack, binance, logger } = require('../../../../helpers');

      PubSubMock = PubSub;
      slackMock = slack;
      loggerMock = logger;
      binanceMock = binance;

      PubSubMock.publish = jest.fn().mockResolvedValue(true);
      slackMock.sendMessage = jest.fn().mockResolvedValue(true);
      binanceMock.client.cancelOrder = jest.fn().mockResolvedValue(true);

      mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([]);
      mockGetAPILimit = jest.fn().mockResolvedValue(10);
      mockIsActionDisabled = jest.fn().mockResolvedValue({
        isDiabled: false,
        ttl: -2
      });
      mockRemoveLastBuyPrice = jest.fn().mockResolvedValue(true);
      mockSaveOrderStats = jest.fn().mockResolvedValue(true);
      mockSaveOverrideAction = jest.fn().mockResolvedValue(true);

      mockArchiveSymbolGridTrade = jest.fn().mockResolvedValue({
        profit: 0,
        profitPercentage: 0,
        totalBuyQuoteQty: 0,
        totalSellQuoteQty: 0
      });
      mockDeleteSymbolGridTrade = jest.fn().mockResolvedValue(true);
      mockGetSymbolGridTrade = jest.fn().mockResolvedValue({});

      mockGetGridTradeOrder = jest.fn().mockResolvedValue({});
    });

    describe('when action is not `not-determined`', () => {
      beforeEach(async () => {
        jest.mock('../../../trailingTradeHelper/common', () => ({
          isActionDisabled: mockIsActionDisabled,
          getAPILimit: mockGetAPILimit,
          removeLastBuyPrice: mockRemoveLastBuyPrice,
          saveOrderStats: mockSaveOrderStats,
          saveOverrideAction: mockSaveOverrideAction,
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol
        }));

        jest.mock('../../../trailingTradeHelper/configuration', () => ({
          archiveSymbolGridTrade: mockArchiveSymbolGridTrade,
          deleteSymbolGridTrade: mockDeleteSymbolGridTrade,
          getSymbolGridTrade: mockGetSymbolGridTrade
        }));

        jest.mock('../../../trailingTradeHelper/order', () => ({
          getGridTradeOrder: mockGetGridTradeOrder
        }));

        const step = require('../remove-last-buy-price');

        rawData = {
          action: 'buy',
          symbol: 'BTCUPUSDT',
          symbolConfiguration: {
            symbols: ['BTCUPUSDT', 'BTCUSDT', 'BNBUSDT'],
            buy: { lastBuyPriceRemoveThreshold: 10 }
          },
          symbolInfo: {
            filterLotSize: {
              stepSize: '0.01000000',
              minQty: '0.01000000'
            },
            filterMinNotional: {
              minNotional: '10.00000000'
            }
          },
          openOrders: [],
          baseAssetBalance: {
            free: 0,
            locked: 0
          },
          sell: {
            currentPrice: 200,
            lastBuyPrice: null
          }
        };

        result = await step.execute(loggerMock, rawData);
      });

      it('does not trigger archiveSymbolGridTrade', () => {
        expect(mockArchiveSymbolGridTrade).not.toHaveBeenCalled();
      });

      it('does not trigger deleteSymbolGridTrade', () => {
        expect(mockDeleteSymbolGridTrade).not.toHaveBeenCalled();
      });

      it('does not trigger saveOrderStats', () => {
        expect(mockSaveOrderStats).not.toHaveBeenCalled();
      });

      it('returns expected data', () => {
        expect(result).toStrictEqual(rawData);
      });
    });

    describe('when last buy price is not set', () => {
      beforeEach(async () => {
        jest.mock('../../../trailingTradeHelper/common', () => ({
          isActionDisabled: mockIsActionDisabled,
          getAPILimit: mockGetAPILimit,
          removeLastBuyPrice: mockRemoveLastBuyPrice,
          saveOrderStats: mockSaveOrderStats,
          saveOverrideAction: mockSaveOverrideAction,
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol
        }));

        jest.mock('../../../trailingTradeHelper/configuration', () => ({
          archiveSymbolGridTrade: mockArchiveSymbolGridTrade,
          deleteSymbolGridTrade: mockDeleteSymbolGridTrade,
          getSymbolGridTrade: mockGetSymbolGridTrade
        }));

        mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);

        jest.mock('../../../trailingTradeHelper/order', () => ({
          getGridTradeOrder: mockGetGridTradeOrder
        }));

        const step = require('../remove-last-buy-price');

        rawData = {
          action: 'not-determined',
          symbol: 'BTCUPUSDT',
          symbolConfiguration: {
            symbols: ['BTCUPUSDT', 'BTCUSDT', 'BNBUSDT'],
            buy: { lastBuyPriceRemoveThreshold: 10 }
          },
          symbolInfo: {
            filterLotSize: {
              stepSize: '0.01000000',
              minQty: '0.01000000'
            },
            filterMinNotional: {
              minNotional: '10.00000000'
            }
          },
          openOrders: [],
          baseAssetBalance: {
            free: 0,
            locked: 0
          },
          sell: {
            currentPrice: 200,
            lastBuyPrice: null
          }
        };

        result = await step.execute(loggerMock, rawData);
      });

      it('does not trigger archiveSymbolGridTrade', () => {
        expect(mockArchiveSymbolGridTrade).not.toHaveBeenCalled();
      });

      it('does not trigger deleteSymbolGridTrade', () => {
        expect(mockDeleteSymbolGridTrade).not.toHaveBeenCalled();
      });

      it('does not trigger saveOrderStats', () => {
        expect(mockSaveOrderStats).not.toHaveBeenCalled();
      });

      it('returns expected data', () => {
        expect(result).toStrictEqual(rawData);
      });
    });

    describe('when action is disabled', () => {
      beforeEach(async () => {
        mockIsActionDisabled = jest.fn().mockResolvedValue({
          isDisabled: true,
          canRemoveLastBuyPrice: false
        });

        jest.mock('../../../trailingTradeHelper/common', () => ({
          isActionDisabled: mockIsActionDisabled,
          getAPILimit: mockGetAPILimit,
          removeLastBuyPrice: mockRemoveLastBuyPrice,
          saveOrderStats: mockSaveOrderStats,
          saveOverrideAction: mockSaveOverrideAction,
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol
        }));

        jest.mock('../../../trailingTradeHelper/configuration', () => ({
          archiveSymbolGridTrade: mockArchiveSymbolGridTrade,
          deleteSymbolGridTrade: mockDeleteSymbolGridTrade,
          getSymbolGridTrade: mockGetSymbolGridTrade
        }));

        mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);

        jest.mock('../../../trailingTradeHelper/order', () => ({
          getGridTradeOrder: mockGetGridTradeOrder
        }));

        const step = require('../remove-last-buy-price');

        rawData = {
          action: 'not-determined',
          symbol: 'BTCUPUSDT',
          symbolConfiguration: {
            symbols: ['BTCUPUSDT', 'BTCUSDT', 'BNBUSDT'],
            buy: { lastBuyPriceRemoveThreshold: 10 }
          },
          symbolInfo: {
            filterLotSize: {
              stepSize: '0.01000000',
              minQty: '0.01000000'
            },
            filterMinNotional: {
              minNotional: '10.00000000'
            }
          },
          openOrders: [],
          baseAssetBalance: {
            free: 0,
            locked: 0
          },
          sell: {
            currentPrice: 200,
            lastBuyPrice: 190
          }
        };

        result = await step.execute(loggerMock, rawData);
      });

      it('does not trigger archiveSymbolGridTrade', () => {
        expect(mockArchiveSymbolGridTrade).not.toHaveBeenCalled();
      });

      it('does not trigger deleteSymbolGridTrade', () => {
        expect(mockDeleteSymbolGridTrade).not.toHaveBeenCalled();
      });

      it('does not trigger saveOrderStats', () => {
        expect(mockSaveOrderStats).not.toHaveBeenCalled();
      });

      it('returns expected data', () => {
        expect(result).toStrictEqual(rawData);
      });
    });

    describe('when grid trade last sell order exists', () => {
      beforeEach(async () => {
        jest.mock('../../../trailingTradeHelper/common', () => ({
          isActionDisabled: mockIsActionDisabled,
          getAPILimit: mockGetAPILimit,
          removeLastBuyPrice: mockRemoveLastBuyPrice,
          saveOrderStats: mockSaveOrderStats,
          saveOverrideAction: mockSaveOverrideAction,
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol
        }));

        jest.mock('../../../trailingTradeHelper/configuration', () => ({
          archiveSymbolGridTrade: mockArchiveSymbolGridTrade,
          deleteSymbolGridTrade: mockDeleteSymbolGridTrade,
          getSymbolGridTrade: mockGetSymbolGridTrade
        }));

        mockGetGridTradeOrder = jest.fn().mockImplementation((_logger, key) => {
          if (key === 'BTCUPUSDT-grid-trade-last-sell-order') {
            return { orderId: 123 };
          }
          return null;
        });

        jest.mock('../../../trailingTradeHelper/order', () => ({
          getGridTradeOrder: mockGetGridTradeOrder
        }));

        const step = require('../remove-last-buy-price');

        rawData = {
          action: 'not-determined',
          symbol: 'BTCUPUSDT',
          symbolConfiguration: {
            symbols: ['BTCUPUSDT', 'BTCUSDT', 'BNBUSDT'],
            buy: { lastBuyPriceRemoveThreshold: 10 }
          },
          symbolInfo: {
            filterLotSize: {
              stepSize: '0.01000000',
              minQty: '0.01000000'
            },
            filterMinNotional: {
              minNotional: '10.00000000'
            }
          },
          openOrders: [],
          baseAssetBalance: {
            free: 0,
            locked: 0
          },
          sell: {
            currentPrice: 200,
            lastBuyPrice: 160
          }
        };

        result = await step.execute(loggerMock, rawData);
      });

      it('does not trigger archiveSymbolGridTrade', () => {
        expect(mockArchiveSymbolGridTrade).not.toHaveBeenCalled();
      });

      it('does not trigger deleteSymbolGridTrade', () => {
        expect(mockDeleteSymbolGridTrade).not.toHaveBeenCalled();
      });

      it('does not trigger saveOrderStats', () => {
        expect(mockSaveOrderStats).not.toHaveBeenCalled();
      });

      it('returns expected data', () => {
        expect(result).toStrictEqual(rawData);
      });
    });

    describe('when sell order is completed', () => {
      beforeEach(() => {
        mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([
          {
            orderId: 123456
          }
        ]);

        jest.mock('../../../trailingTradeHelper/common', () => ({
          isActionDisabled: mockIsActionDisabled,
          getAPILimit: mockGetAPILimit,
          removeLastBuyPrice: mockRemoveLastBuyPrice,
          saveOrderStats: mockSaveOrderStats,
          saveOverrideAction: mockSaveOverrideAction,
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol
        }));

        mockArchiveSymbolGridTrade = jest.fn().mockResolvedValue({
          profit: 10,
          profitPercentage: 0.1,
          totalBuyQuoteBuy: 100,
          totalSellQuoteQty: 110
        });

        mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);

        jest.mock('../../../trailingTradeHelper/order', () => ({
          getGridTradeOrder: mockGetGridTradeOrder
        }));

        rawData = {
          action: 'not-determined',
          symbol: 'BTCUPUSDT',
          symbolConfiguration: {
            symbols: ['BTCUSDT', 'BNBUSDT', 'BTCUPUSDT'],
            buy: { lastBuyPriceRemoveThreshold: 10 },
            botOptions: {
              autoTriggerBuy: {
                enabled: true,
                triggerAfter: 20
              }
            }
          },
          symbolInfo: {
            filterLotSize: {
              stepSize: '0.01000000',
              minQty: '0.01000000'
            },
            filterMinNotional: {
              minNotional: '10.00000000'
            }
          },
          openOrders: [
            {
              orderId: 123456
            }
          ],
          baseAssetBalance: {
            free: 0,
            locked: 0.2
          },
          sell: {
            currentPrice: 200,
            lastBuyPrice: 160
          }
        };
      });

      describe('when symbol grid trade is empty', () => {
        beforeEach(async () => {
          mockGetSymbolGridTrade = jest.fn().mockResolvedValue({});

          jest.mock('../../../trailingTradeHelper/configuration', () => ({
            archiveSymbolGridTrade: mockArchiveSymbolGridTrade,
            deleteSymbolGridTrade: mockDeleteSymbolGridTrade,
            getSymbolGridTrade: mockGetSymbolGridTrade
          }));

          const step = require('../remove-last-buy-price');

          result = await step.execute(loggerMock, rawData);
        });

        it('does not trigger binance.client.cancelOrder', () => {
          expect(binanceMock.client.cancelOrder).not.toHaveBeenCalled();
        });

        it('does not trigger removeLastBuyPrice', () => {
          expect(mockRemoveLastBuyPrice).not.toHaveBeenCalled();
        });

        it('does not trigger archiveSymbolGridTrade', () => {
          expect(mockArchiveSymbolGridTrade).not.toHaveBeenCalled();
        });

        it('does not trigger deleteSymbolGridTrade', () => {
          expect(mockDeleteSymbolGridTrade).not.toHaveBeenCalled();
        });

        it('does not trigger saveOverrideAction', () => {
          expect(mockSaveOverrideAction).not.toHaveBeenCalled();
        });

        it('does not trigger saveOrderStats', () => {
          expect(mockSaveOrderStats).not.toHaveBeenCalled();
        });

        it('returns expected data', () => {
          expect(result).toStrictEqual({
            ...rawData
          });
        });
      });

      describe('when sell array of symbol grid trade is empty', () => {
        beforeEach(async () => {
          mockGetSymbolGridTrade = jest.fn().mockResolvedValue({
            sell: []
          });

          jest.mock('../../../trailingTradeHelper/configuration', () => ({
            archiveSymbolGridTrade: mockArchiveSymbolGridTrade,
            deleteSymbolGridTrade: mockDeleteSymbolGridTrade,
            getSymbolGridTrade: mockGetSymbolGridTrade
          }));

          const step = require('../remove-last-buy-price');

          result = await step.execute(loggerMock, rawData);
        });

        it('does not trigger binance.client.cancelOrder', () => {
          expect(binanceMock.client.cancelOrder).not.toHaveBeenCalled();
        });

        it('does not trigger removeLastBuyPrice', () => {
          expect(mockRemoveLastBuyPrice).not.toHaveBeenCalled();
        });

        it('does not trigger archiveSymbolGridTrade', () => {
          expect(mockArchiveSymbolGridTrade).not.toHaveBeenCalled();
        });

        it('does not trigger deleteSymbolGridTrade', () => {
          expect(mockDeleteSymbolGridTrade).not.toHaveBeenCalled();
        });

        it('does not trigger saveOverrideAction', () => {
          expect(mockSaveOverrideAction).not.toHaveBeenCalled();
        });

        it('does not trigger saveOrderStats', () => {
          expect(mockSaveOrderStats).not.toHaveBeenCalled();
        });

        it('returns expected data', () => {
          expect(result).toStrictEqual({
            ...rawData
          });
        });
      });

      describe('there is no sell order executed', () => {
        beforeEach(async () => {
          mockGetSymbolGridTrade = jest.fn().mockResolvedValue({
            sell: [
              {
                executed: true
              },
              {
                executed: false
              }
            ]
          });

          jest.mock('../../../trailingTradeHelper/configuration', () => ({
            archiveSymbolGridTrade: mockArchiveSymbolGridTrade,
            deleteSymbolGridTrade: mockDeleteSymbolGridTrade,
            getSymbolGridTrade: mockGetSymbolGridTrade
          }));

          const step = require('../remove-last-buy-price');

          result = await step.execute(loggerMock, rawData);
        });

        it('does not trigger binance.client.cancelOrder', () => {
          expect(binanceMock.client.cancelOrder).not.toHaveBeenCalled();
        });

        it('does not trigger removeLastBuyPrice', () => {
          expect(mockRemoveLastBuyPrice).not.toHaveBeenCalled();
        });

        it('does not trigger archiveSymbolGridTrade', () => {
          expect(mockArchiveSymbolGridTrade).not.toHaveBeenCalled();
        });

        it('does not trigger deleteSymbolGridTrade', () => {
          expect(mockDeleteSymbolGridTrade).not.toHaveBeenCalled();
        });

        it('does not trigger saveOverrideAction', () => {
          expect(mockSaveOverrideAction).not.toHaveBeenCalled();
        });

        it('does not trigger saveOrderStats', () => {
          expect(mockSaveOrderStats).not.toHaveBeenCalled();
        });

        it('returns expected data', () => {
          expect(result).toStrictEqual({
            ...rawData
          });
        });
      });

      describe('there is all sell order executed with not-determined', () => {
        beforeEach(async () => {
          mockGetSymbolGridTrade = jest.fn().mockResolvedValue({
            sell: [
              {
                executed: true
              },
              {
                executed: true
              }
            ]
          });

          jest.mock('../../../trailingTradeHelper/configuration', () => ({
            archiveSymbolGridTrade: mockArchiveSymbolGridTrade,
            deleteSymbolGridTrade: mockDeleteSymbolGridTrade,
            getSymbolGridTrade: mockGetSymbolGridTrade
          }));

          const step = require('../remove-last-buy-price');

          result = await step.execute(loggerMock, rawData);
        });

        it('triggers binance.client.cancelOrder', () => {
          expect(binanceMock.client.cancelOrder).toHaveBeenCalledWith({
            symbol: 'BTCUPUSDT',
            orderId: 123456
          });
        });

        it('triggers removeLastBuyPrice', () => {
          expect(mockRemoveLastBuyPrice).toHaveBeenCalledWith(
            loggerMock,
            'BTCUPUSDT'
          );
        });

        it('triggers archiveSymbolGridTrade', () => {
          expect(mockArchiveSymbolGridTrade).toHaveBeenCalledWith(
            loggerMock,
            'BTCUPUSDT'
          );
        });

        it('triggers deleteSymbolGridTrade', () => {
          expect(mockDeleteSymbolGridTrade).toHaveBeenCalledWith(
            loggerMock,
            'BTCUPUSDT'
          );
        });

        it('triggers saveOverrideAction', () => {
          expect(mockSaveOverrideAction).toHaveBeenCalledWith(
            loggerMock,
            'BTCUPUSDT',
            {
              action: 'buy',
              actionAt: expect.any(String),
              triggeredBy: 'auto-trigger',
              notify: true,
              checkTradingView: true
            },
            `The bot queued the action to trigger the grid trade for buying after 20 minutes later.`
          );
        });

        it('triggers saveOrderStats', () => {
          expect(mockSaveOrderStats).toHaveBeenCalledWith(loggerMock, [
            'BTCUSDT',
            'BNBUSDT',
            'BTCUPUSDT'
          ]);
        });

        it('returns expected data', () => {
          expect(result).toStrictEqual({
            ...rawData,
            ...{
              sell: {
                currentPrice: 200,
                lastBuyPrice: 160,
                processMessage:
                  'All sell orders are executed. Delete last buy price.',
                updatedAt: expect.any(Object)
              }
            }
          });
        });
      });

      describe('there is all sell order executed with buy-order-wait', () => {
        beforeEach(async () => {
          mockGetSymbolGridTrade = jest.fn().mockResolvedValue({
            sell: [
              {
                executed: true
              },
              {
                executed: true
              }
            ]
          });

          jest.mock('../../../trailingTradeHelper/configuration', () => ({
            archiveSymbolGridTrade: mockArchiveSymbolGridTrade,
            deleteSymbolGridTrade: mockDeleteSymbolGridTrade,
            getSymbolGridTrade: mockGetSymbolGridTrade
          }));

          const step = require('../remove-last-buy-price');

          rawData.action = 'buy-order-wait';
          result = await step.execute(loggerMock, rawData);
        });

        it('triggers binance.client.cancelOrder', () => {
          expect(binanceMock.client.cancelOrder).toHaveBeenCalledWith({
            symbol: 'BTCUPUSDT',
            orderId: 123456
          });
        });

        it('triggers removeLastBuyPrice', () => {
          expect(mockRemoveLastBuyPrice).toHaveBeenCalledWith(
            loggerMock,
            'BTCUPUSDT'
          );
        });

        it('triggers archiveSymbolGridTrade', () => {
          expect(mockArchiveSymbolGridTrade).toHaveBeenCalledWith(
            loggerMock,
            'BTCUPUSDT'
          );
        });

        it('triggers deleteSymbolGridTrade', () => {
          expect(mockDeleteSymbolGridTrade).toHaveBeenCalledWith(
            loggerMock,
            'BTCUPUSDT'
          );
        });

        it('triggers saveOverrideAction', () => {
          expect(mockSaveOverrideAction).toHaveBeenCalledWith(
            loggerMock,
            'BTCUPUSDT',
            {
              action: 'buy',
              actionAt: expect.any(String),
              triggeredBy: 'auto-trigger',
              notify: true,
              checkTradingView: true
            },
            `The bot queued the action to trigger the grid trade for buying after 20 minutes later.`
          );
        });

        it('triggers saveOrderStats', () => {
          expect(mockSaveOrderStats).toHaveBeenCalledWith(loggerMock, [
            'BTCUSDT',
            'BNBUSDT',
            'BTCUPUSDT'
          ]);
        });

        it('returns expected data', () => {
          expect(result).toStrictEqual({
            ...rawData,
            ...{
              sell: {
                currentPrice: 200,
                lastBuyPrice: 160,
                processMessage:
                  'All sell orders are executed. Delete last buy price.',
                updatedAt: expect.any(Object)
              }
            }
          });
        });
      });
    });

    describe('when quantity is not enough to sell', () => {
      beforeEach(() => {
        jest.mock('../../../trailingTradeHelper/common', () => ({
          isActionDisabled: mockIsActionDisabled,
          getAPILimit: mockGetAPILimit,
          removeLastBuyPrice: mockRemoveLastBuyPrice,
          saveOrderStats: mockSaveOrderStats,
          saveOverrideAction: mockSaveOverrideAction,
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol
        }));

        mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);

        jest.mock('../../../trailingTradeHelper/order', () => ({
          getGridTradeOrder: mockGetGridTradeOrder
        }));
      });

      [
        {
          symbol: 'ALPHABTC',
          archivedSymbolGridTradeResult: {
            profit: 10,
            profitPercentage: 0.1,
            totalBuyQuoteBuy: 100,
            totalSellQuoteQty: 110
          },
          rawData: {
            action: 'not-determined',
            symbol: 'ALPHABTC',
            symbolConfiguration: {
              symbols: ['BTCUSDT', 'BNBUSDT', 'ALPHABTC'],
              buy: { lastBuyPriceRemoveThreshold: 0.0001 },
              botOptions: {
                autoTriggerBuy: {
                  enabled: true,
                  triggerAfter: 20
                }
              }
            },
            symbolInfo: {
              filterLotSize: {
                stepSize: '1.00000000',
                minQty: '1.00000000'
              },
              filterMinNotional: {
                minNotional: '0.00010000'
              }
            },
            openOrders: [],
            baseAssetBalance: {
              free: 1,
              locked: 0
            },
            sell: {
              currentPrice: 0.000038,
              lastBuyPrice: 0.00003179
            }
          }
        },
        {
          symbol: 'BTCUPUSDT',
          archivedSymbolGridTradeResult: {},
          rawData: {
            action: 'not-determined',
            symbol: 'BTCUPUSDT',
            symbolConfiguration: {
              symbols: ['BTCUSDT', 'BNBUSDT', 'BTCUPUSDT'],
              buy: { lastBuyPriceRemoveThreshold: 10 },
              botOptions: {
                autoTriggerBuy: {
                  enabled: false,
                  triggerAfter: 20
                }
              }
            },
            symbolInfo: {
              filterLotSize: {
                stepSize: '0.01000000',
                minQty: '0.01000000'
              },
              filterMinNotional: {
                minNotional: '10.00000000'
              }
            },
            openOrders: [],
            baseAssetBalance: {
              free: 0,
              locked: 0
            },
            sell: {
              currentPrice: 200,
              lastBuyPrice: 160
            }
          }
        }
      ].forEach(test => {
        describe(`${test.symbol}`, () => {
          beforeEach(async () => {
            mockArchiveSymbolGridTrade = jest
              .fn()
              .mockResolvedValue(test.archivedSymbolGridTradeResult);

            jest.mock('../../../trailingTradeHelper/configuration', () => ({
              archiveSymbolGridTrade: mockArchiveSymbolGridTrade,
              deleteSymbolGridTrade: mockDeleteSymbolGridTrade,
              getSymbolGridTrade: mockGetSymbolGridTrade
            }));

            const step = require('../remove-last-buy-price');

            result = await step.execute(loggerMock, test.rawData);
          });

          it('triggers removeLastBuyPrice', () => {
            expect(mockRemoveLastBuyPrice).toHaveBeenCalledWith(
              loggerMock,
              test.symbol
            );
          });

          it('triggers archiveSymbolGridTrade', () => {
            expect(mockArchiveSymbolGridTrade).toHaveBeenCalledWith(
              loggerMock,
              test.symbol
            );
          });

          it('triggers deleteSymbolGridTrade', () => {
            expect(mockDeleteSymbolGridTrade).toHaveBeenCalledWith(
              loggerMock,
              test.symbol
            );
          });

          if (
            test.rawData.symbolConfiguration.botOptions.autoTriggerBuy.enabled
          ) {
            it('triggers saveOverrideAction', () => {
              expect(mockSaveOverrideAction).toHaveBeenCalledWith(
                loggerMock,
                test.symbol,
                {
                  action: 'buy',
                  actionAt: expect.any(String),
                  triggeredBy: 'auto-trigger',
                  notify: true,
                  checkTradingView: true
                },
                `The bot queued the action to trigger the grid trade for buying after` +
                  ` ${test.rawData.symbolConfiguration.botOptions.autoTriggerBuy.triggerAfter} minutes later.`
              );
            });
          } else {
            it('does not trigger saveOverrideAction', () => {
              expect(mockSaveOverrideAction).not.toHaveBeenCalled();
            });
          }

          it('triggers saveOrderStats', () => {
            expect(mockSaveOrderStats).toHaveBeenCalledWith(
              loggerMock,
              test.rawData.symbolConfiguration.symbols
            );
          });

          it('returns expected data', () => {
            expect(result).toMatchObject({
              sell: {
                processMessage:
                  'Balance is not enough to sell. Delete last buy price.',
                updatedAt: expect.any(Object)
              }
            });
          });
        });
      });
    });

    describe('when balance is less than minimum notional', () => {
      describe('last buy price remove threshold is same as minimum notional', () => {
        beforeEach(async () => {
          jest.mock('../../../trailingTradeHelper/common', () => ({
            isActionDisabled: mockIsActionDisabled,
            getAPILimit: mockGetAPILimit,
            removeLastBuyPrice: mockRemoveLastBuyPrice,
            saveOrderStats: mockSaveOrderStats,
            saveOverrideAction: mockSaveOverrideAction,
            getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol
          }));

          mockArchiveSymbolGridTrade = jest.fn().mockResolvedValue({
            profit: -10,
            profitPercentage: -0.1,
            totalBuyQuoteBuy: 110,
            totalSellQuoteQty: 100
          });

          jest.mock('../../../trailingTradeHelper/configuration', () => ({
            archiveSymbolGridTrade: mockArchiveSymbolGridTrade,
            deleteSymbolGridTrade: mockDeleteSymbolGridTrade,
            getSymbolGridTrade: mockGetSymbolGridTrade
          }));

          mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);

          jest.mock('../../../trailingTradeHelper/order', () => ({
            getGridTradeOrder: mockGetGridTradeOrder
          }));

          const step = require('../remove-last-buy-price');

          rawData = {
            action: 'not-determined',
            symbol: 'BTCUPUSDT',
            symbolConfiguration: {
              symbols: ['BTCUSDT', 'BNBUSDT', 'BTCUPUSDT'],
              buy: { lastBuyPriceRemoveThreshold: 10 },
              botOptions: {
                autoTriggerBuy: {
                  enabled: true,
                  triggerAfter: 20
                }
              }
            },
            symbolInfo: {
              filterLotSize: {
                stepSize: '0.01000000',
                minQty: '0.01000000'
              },
              filterMinNotional: {
                minNotional: '10.00000000'
              }
            },
            openOrders: [],
            baseAssetBalance: {
              free: 0,
              locked: 0.04
            },
            sell: {
              currentPrice: 200,
              lastBuyPrice: 160
            }
          };

          result = await step.execute(loggerMock, rawData);
        });

        it('triggers removeLastBuyPrice', () => {
          expect(mockRemoveLastBuyPrice).toHaveBeenCalledWith(
            loggerMock,
            'BTCUPUSDT'
          );
        });

        it('triggers archiveSymbolGridTrade', () => {
          expect(mockArchiveSymbolGridTrade).toHaveBeenCalledWith(
            loggerMock,
            'BTCUPUSDT'
          );
        });

        it('triggers deleteSymbolGridTrade', () => {
          expect(mockDeleteSymbolGridTrade).toHaveBeenCalledWith(
            loggerMock,
            'BTCUPUSDT'
          );
        });

        it('triggers saveOverrideAction', () => {
          expect(mockSaveOverrideAction).toHaveBeenCalledWith(
            loggerMock,
            'BTCUPUSDT',
            {
              action: 'buy',
              actionAt: expect.any(String),
              triggeredBy: 'auto-trigger',
              notify: true,
              checkTradingView: true
            },
            `The bot queued the action to trigger the grid trade for buying after 20 minutes later.`
          );
        });

        it('triggers saveOrderStats', () => {
          expect(mockSaveOrderStats).toHaveBeenCalledWith(loggerMock, [
            'BTCUSDT',
            'BNBUSDT',
            'BTCUPUSDT'
          ]);
        });

        it('returns expected data', () => {
          expect(result).toStrictEqual({
            ...rawData,
            ...{
              sell: {
                currentPrice: 200,
                lastBuyPrice: 160,
                processMessage:
                  'Balance is less than the last buy price remove threshold. Delete last buy price.',
                updatedAt: expect.any(Object)
              }
            }
          });
        });
      });

      describe('last buy price remove threshold is less than minimum notional', () => {
        beforeEach(async () => {
          jest.mock('../../../trailingTradeHelper/common', () => ({
            isActionDisabled: mockIsActionDisabled,
            getAPILimit: mockGetAPILimit,
            removeLastBuyPrice: mockRemoveLastBuyPrice,
            saveOrderStats: mockSaveOrderStats,
            saveOverrideAction: mockSaveOverrideAction,
            getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol
          }));

          mockArchiveSymbolGridTrade = jest.fn().mockResolvedValue({
            profit: 10,
            profitPercentage: 0.1,
            totalBuyQuoteBuy: 100,
            totalSellQuoteQty: 110
          });

          jest.mock('../../../trailingTradeHelper/configuration', () => ({
            archiveSymbolGridTrade: mockArchiveSymbolGridTrade,
            deleteSymbolGridTrade: mockDeleteSymbolGridTrade,
            getSymbolGridTrade: mockGetSymbolGridTrade
          }));

          mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);

          jest.mock('../../../trailingTradeHelper/order', () => ({
            getGridTradeOrder: mockGetGridTradeOrder
          }));

          const step = require('../remove-last-buy-price');

          rawData = {
            action: 'not-determined',
            symbol: 'BTCUPUSDT',
            symbolConfiguration: {
              symbols: ['BTCUSDT', 'BNBUSDT', 'BTCUPUSDT'],
              buy: { lastBuyPriceRemoveThreshold: 5 },
              botOptions: {
                autoTriggerBuy: {
                  enabled: false,
                  triggerAfter: 20
                }
              }
            },
            symbolInfo: {
              filterLotSize: {
                stepSize: '0.01000000',
                minQty: '0.01000000'
              },
              filterMinNotional: {
                minNotional: '10.00000000'
              }
            },
            openOrders: [],
            baseAssetBalance: {
              free: 0,
              locked: 0.04
            },
            sell: {
              currentPrice: 200,
              lastBuyPrice: 160
            }
          };

          result = await step.execute(loggerMock, rawData);
        });

        it('does not trigger removeLastBuyPrice', () => {
          expect(mockRemoveLastBuyPrice).not.toHaveBeenCalled();
        });

        it('does not trigger archiveSymbolGridTrade', () => {
          expect(mockArchiveSymbolGridTrade).not.toHaveBeenCalled();
        });

        it('does not trigger deleteSymbolGridTrade', () => {
          expect(mockDeleteSymbolGridTrade).not.toHaveBeenCalled();
        });

        it('does not trigger saveOverrideAction', () => {
          expect(mockSaveOverrideAction).not.toHaveBeenCalled();
        });

        it('does not trigger saveOrderStats', () => {
          expect(mockSaveOrderStats).not.toHaveBeenCalled();
        });

        it('returns expected data', () => {
          expect(result).toStrictEqual(rawData);
        });
      });
    });

    describe('when there is enough balance', () => {
      beforeEach(async () => {
        jest.mock('../../../trailingTradeHelper/common', () => ({
          isActionDisabled: mockIsActionDisabled,
          getAPILimit: mockGetAPILimit,
          removeLastBuyPrice: mockRemoveLastBuyPrice,
          saveOrderStats: mockSaveOrderStats,
          saveOverrideAction: mockSaveOverrideAction,
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol
        }));

        mockArchiveSymbolGridTrade = jest.fn().mockResolvedValue({
          profit: 10,
          profitPercentage: 0.1,
          totalBuyQuoteBuy: 100,
          totalSellQuoteQty: 110
        });

        mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);

        jest.mock('../../../trailingTradeHelper/order', () => ({
          getGridTradeOrder: mockGetGridTradeOrder
        }));

        rawData = {
          action: 'not-determined',
          symbol: 'BTCUPUSDT',
          symbolConfiguration: {
            symbols: ['BTCUSDT', 'BNBUSDT', 'BTCUPUSDT'],
            buy: { lastBuyPriceRemoveThreshold: 10 },
            botOptions: {
              autoTriggerBuy: {
                enabled: true,
                triggerAfter: 20
              }
            }
          },
          symbolInfo: {
            filterLotSize: {
              stepSize: '0.01000000',
              minQty: '0.01000000'
            },
            filterMinNotional: {
              minNotional: '10.00000000'
            }
          },
          openOrders: [],
          baseAssetBalance: {
            free: 0,
            locked: 0.2
          },
          sell: {
            currentPrice: 200,
            lastBuyPrice: 160
          }
        };

        jest.mock('../../../trailingTradeHelper/configuration', () => ({
          archiveSymbolGridTrade: mockArchiveSymbolGridTrade,
          deleteSymbolGridTrade: mockDeleteSymbolGridTrade,
          getSymbolGridTrade: mockGetSymbolGridTrade
        }));

        const step = require('../remove-last-buy-price');

        result = await step.execute(loggerMock, rawData);
      });

      it('does not trigger binance.client.cancelOrder', () => {
        expect(binanceMock.client.cancelOrder).not.toHaveBeenCalled();
      });

      it('does not trigger removeLastBuyPrice', () => {
        expect(mockRemoveLastBuyPrice).not.toHaveBeenCalled();
      });

      it('does not trigger archiveSymbolGridTrade', () => {
        expect(mockArchiveSymbolGridTrade).not.toHaveBeenCalled();
      });

      it('does not trigger deleteSymbolGridTrade', () => {
        expect(mockDeleteSymbolGridTrade).not.toHaveBeenCalled();
      });

      it('does not trigger saveOverrideAction', () => {
        expect(mockSaveOverrideAction).not.toHaveBeenCalled();
      });

      it('does not trigger saveOrderStats', () => {
        expect(mockSaveOrderStats).not.toHaveBeenCalled();
      });

      it('returns expected data', () => {
        expect(result).toStrictEqual({
          ...rawData
        });
      });
    });
  });
});
