/* eslint-disable global-require */

describe('remove-last-buy-price.js', () => {
  let result;
  let rawData;

  let PubSubMock;
  let cacheMock;
  let slackMock;
  let loggerMock;

  let mockGetAndCacheOpenOrdersForSymbol;
  let mockGetAPILimit;
  let mockIsActionDisabled;
  let mockRemoveLastBuyPrice;

  let mockArchiveSymbolGridTrade;
  let mockDeleteSymbolGridTrade;

  let mockGetGridTradeOrder;

  describe('execute', () => {
    beforeEach(() => {
      jest.clearAllMocks().resetModules();
    });

    beforeEach(async () => {
      const { PubSub, cache, slack, logger } = require('../../../../helpers');

      PubSubMock = PubSub;
      cacheMock = cache;
      slackMock = slack;
      loggerMock = logger;

      PubSubMock.publish = jest.fn().mockResolvedValue(true);
      slackMock.sendMessage = jest.fn().mockResolvedValue(true);
      cacheMock.get = jest.fn().mockResolvedValue(null);
      cacheMock.hset = jest.fn().mockResolvedValue(true);

      mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([]);
      mockGetAPILimit = jest.fn().mockResolvedValue(10);
      mockIsActionDisabled = jest.fn().mockResolvedValue({
        isDiabled: false,
        ttl: -2
      });
      mockRemoveLastBuyPrice = jest.fn().mockResolvedValue(true);

      mockArchiveSymbolGridTrade = jest.fn().mockResolvedValue({
        profit: 0,
        profitPercentage: 0,
        totalBuyQuoteQty: 0,
        totalSellQuoteQty: 0
      });
      mockDeleteSymbolGridTrade = jest.fn().mockResolvedValue(true);

      mockGetGridTradeOrder = jest.fn().mockResolvedValue({});
    });

    describe('when symbol is locked', () => {
      beforeEach(async () => {
        jest.mock('../../../trailingTradeHelper/common', () => ({
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
          isActionDisabled: mockIsActionDisabled,
          getAPILimit: mockGetAPILimit,
          removeLastBuyPrice: mockRemoveLastBuyPrice
        }));

        jest.mock('../../../trailingTradeHelper/configuration', () => ({
          archiveSymbolGridTrade: mockArchiveSymbolGridTrade,
          deleteSymbolGridTrade: mockDeleteSymbolGridTrade
        }));

        jest.mock('../../../trailingTradeHelper/order', () => ({
          getGridTradeOrder: mockGetGridTradeOrder
        }));

        const step = require('../remove-last-buy-price');

        rawData = {
          action: 'not-determined',
          isLocked: true,
          symbol: 'BTCUPUSDT',
          symbolConfiguration: {
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

      it('returns expected data', () => {
        expect(result).toStrictEqual(rawData);
      });
    });

    describe('when action is not `not-determined`', () => {
      beforeEach(async () => {
        jest.mock('../../../trailingTradeHelper/common', () => ({
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
          isActionDisabled: mockIsActionDisabled,
          getAPILimit: mockGetAPILimit,
          removeLastBuyPrice: mockRemoveLastBuyPrice
        }));

        jest.mock('../../../trailingTradeHelper/configuration', () => ({
          archiveSymbolGridTrade: mockArchiveSymbolGridTrade,
          deleteSymbolGridTrade: mockDeleteSymbolGridTrade
        }));

        jest.mock('../../../trailingTradeHelper/order', () => ({
          getGridTradeOrder: mockGetGridTradeOrder
        }));

        const step = require('../remove-last-buy-price');

        rawData = {
          action: 'buy',
          isLocked: false,
          symbol: 'BTCUPUSDT',
          symbolConfiguration: {
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

      it('returns expected data', () => {
        expect(result).toStrictEqual(rawData);
      });
    });

    describe('when grid trade last buy order exists', () => {
      beforeEach(async () => {
        jest.mock('../../../trailingTradeHelper/common', () => ({
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
          isActionDisabled: mockIsActionDisabled,
          getAPILimit: mockGetAPILimit,
          removeLastBuyPrice: mockRemoveLastBuyPrice
        }));

        jest.mock('../../../trailingTradeHelper/configuration', () => ({
          archiveSymbolGridTrade: mockArchiveSymbolGridTrade,
          deleteSymbolGridTrade: mockDeleteSymbolGridTrade
        }));

        mockGetGridTradeOrder = jest.fn().mockImplementation((_logger, key) => {
          if (key === 'BTCUPUSDT-grid-trade-last-buy-order') {
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
          isLocked: false,
          symbol: 'BTCUPUSDT',
          symbolConfiguration: {
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

      it('returns expected data', () => {
        expect(result).toStrictEqual(rawData);
      });
    });

    describe('when grid trade last sell order exists', () => {
      beforeEach(async () => {
        jest.mock('../../../trailingTradeHelper/common', () => ({
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
          isActionDisabled: mockIsActionDisabled,
          getAPILimit: mockGetAPILimit,
          removeLastBuyPrice: mockRemoveLastBuyPrice
        }));

        jest.mock('../../../trailingTradeHelper/configuration', () => ({
          archiveSymbolGridTrade: mockArchiveSymbolGridTrade,
          deleteSymbolGridTrade: mockDeleteSymbolGridTrade
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
          isLocked: false,
          symbol: 'BTCUPUSDT',
          symbolConfiguration: {
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

      it('returns expected data', () => {
        expect(result).toStrictEqual(rawData);
      });
    });

    describe('when last buy price is not set', () => {
      beforeEach(async () => {
        jest.mock('../../../trailingTradeHelper/common', () => ({
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
          isActionDisabled: mockIsActionDisabled,
          getAPILimit: mockGetAPILimit,
          removeLastBuyPrice: mockRemoveLastBuyPrice
        }));

        jest.mock('../../../trailingTradeHelper/configuration', () => ({
          archiveSymbolGridTrade: mockArchiveSymbolGridTrade,
          deleteSymbolGridTrade: mockDeleteSymbolGridTrade
        }));

        mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);

        jest.mock('../../../trailingTradeHelper/order', () => ({
          getGridTradeOrder: mockGetGridTradeOrder
        }));

        const step = require('../remove-last-buy-price');

        rawData = {
          action: 'not-determined',
          isLocked: false,
          symbol: 'BTCUPUSDT',
          symbolConfiguration: {
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

      it('returns expected data', () => {
        expect(result).toStrictEqual(rawData);
      });
    });

    describe('when open orders exist', () => {
      beforeEach(async () => {
        jest.mock('../../../trailingTradeHelper/common', () => ({
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
          isActionDisabled: mockIsActionDisabled,
          getAPILimit: mockGetAPILimit,
          removeLastBuyPrice: mockRemoveLastBuyPrice
        }));

        jest.mock('../../../trailingTradeHelper/configuration', () => ({
          archiveSymbolGridTrade: mockArchiveSymbolGridTrade,
          deleteSymbolGridTrade: mockDeleteSymbolGridTrade
        }));

        mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);

        jest.mock('../../../trailingTradeHelper/order', () => ({
          getGridTradeOrder: mockGetGridTradeOrder
        }));

        const step = require('../remove-last-buy-price');

        rawData = {
          action: 'not-determined',
          isLocked: false,
          symbol: 'BTCUPUSDT',
          symbolConfiguration: {
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
          openOrders: [
            {
              orderId: 123,
              price: 197.8,
              quantity: 0.09,
              side: 'sell',
              stopPrice: 198,
              symbol: 'BTCUPUSDT',
              timeInForce: 'GTC',
              type: 'STOP_LOSS_LIMIT'
            }
          ],
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
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
          isActionDisabled: mockIsActionDisabled,
          getAPILimit: mockGetAPILimit,
          removeLastBuyPrice: mockRemoveLastBuyPrice
        }));

        jest.mock('../../../trailingTradeHelper/configuration', () => ({
          archiveSymbolGridTrade: mockArchiveSymbolGridTrade,
          deleteSymbolGridTrade: mockDeleteSymbolGridTrade
        }));

        mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);

        jest.mock('../../../trailingTradeHelper/order', () => ({
          getGridTradeOrder: mockGetGridTradeOrder
        }));

        const step = require('../remove-last-buy-price');

        rawData = {
          action: 'not-determined',
          isLocked: false,
          symbol: 'BTCUPUSDT',
          symbolConfiguration: {
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

      it('returns expected data', () => {
        expect(result).toStrictEqual(rawData);
      });
    });

    describe('when quantity is not enough to sell', () => {
      describe('when found open orders at this point', () => {
        beforeEach(async () => {
          mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([
            {
              orderId: '123123123'
            }
          ]);

          jest.mock('../../../trailingTradeHelper/common', () => ({
            getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
            isActionDisabled: mockIsActionDisabled,
            getAPILimit: mockGetAPILimit,
            removeLastBuyPrice: mockRemoveLastBuyPrice
          }));

          jest.mock('../../../trailingTradeHelper/configuration', () => ({
            archiveSymbolGridTrade: mockArchiveSymbolGridTrade,
            deleteSymbolGridTrade: mockDeleteSymbolGridTrade
          }));

          mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);

          jest.mock('../../../trailingTradeHelper/order', () => ({
            getGridTradeOrder: mockGetGridTradeOrder
          }));

          const step = require('../remove-last-buy-price');

          rawData = {
            action: 'not-determined',
            isLocked: false,
            symbol: 'BTCUPUSDT',
            symbolConfiguration: {
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

        it('returns expected data', () => {
          expect(result).toStrictEqual(rawData);
        });
      });

      describe('when cannot find open orders', () => {
        describe('ALPHABTC', () => {
          beforeEach(async () => {
            jest.mock('../../../trailingTradeHelper/common', () => ({
              getAndCacheOpenOrdersForSymbol:
                mockGetAndCacheOpenOrdersForSymbol,
              isActionDisabled: mockIsActionDisabled,
              getAPILimit: mockGetAPILimit,
              removeLastBuyPrice: mockRemoveLastBuyPrice
            }));

            mockArchiveSymbolGridTrade = jest.fn().mockResolvedValue({
              profit: 10,
              profitPercentage: 0.1,
              totalBuyQuoteBuy: 100,
              totalSellQuoteQty: 110
            });

            jest.mock('../../../trailingTradeHelper/configuration', () => ({
              archiveSymbolGridTrade: mockArchiveSymbolGridTrade,
              deleteSymbolGridTrade: mockDeleteSymbolGridTrade
            }));

            mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);

            jest.mock('../../../trailingTradeHelper/order', () => ({
              getGridTradeOrder: mockGetGridTradeOrder
            }));

            const step = require('../remove-last-buy-price');

            rawData = {
              action: 'not-determined',
              isLocked: false,
              symbol: 'ALPHABTC',
              symbolConfiguration: {
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
            };

            result = await step.execute(loggerMock, rawData);
          });

          it('triggers removeLastBuyPrice', () => {
            expect(mockRemoveLastBuyPrice).toHaveBeenCalledWith(
              loggerMock,
              'ALPHABTC'
            );
          });

          it('triggers archiveSymbolGridTrade', () => {
            expect(mockArchiveSymbolGridTrade).toHaveBeenCalledWith(
              loggerMock,
              'ALPHABTC'
            );
          });

          it('triggers deleteSymbolGridTrade', () => {
            expect(mockDeleteSymbolGridTrade).toHaveBeenCalledWith(
              loggerMock,
              'ALPHABTC'
            );
          });

          it('triggers cache.set because autoTriggerBuy is enabled', () => {
            expect(cacheMock.hset.mock.calls[0][0]).toStrictEqual(
              'trailing-trade-override'
            );
            expect(cacheMock.hset.mock.calls[0][1]).toStrictEqual('ALPHABTC');
            const args = JSON.parse(cacheMock.hset.mock.calls[0][2]);
            expect(args).toStrictEqual({
              action: 'buy',
              actionAt: expect.any(String)
            });
          });

          it('returns expected data', () => {
            expect(result).toStrictEqual({
              ...rawData,
              ...{
                sell: {
                  currentPrice: 0.000038,
                  lastBuyPrice: 0.00003179,
                  processMessage:
                    'Balance is not enough to sell. Delete last buy price.',
                  updatedAt: expect.any(Object)
                }
              }
            });
          });
        });

        describe('BTCUPUSDT', () => {
          beforeEach(async () => {
            jest.mock('../../../trailingTradeHelper/common', () => ({
              getAndCacheOpenOrdersForSymbol:
                mockGetAndCacheOpenOrdersForSymbol,
              isActionDisabled: mockIsActionDisabled,
              getAPILimit: mockGetAPILimit,
              removeLastBuyPrice: mockRemoveLastBuyPrice
            }));

            mockArchiveSymbolGridTrade = jest.fn().mockResolvedValue({});

            jest.mock('../../../trailingTradeHelper/configuration', () => ({
              archiveSymbolGridTrade: mockArchiveSymbolGridTrade,
              deleteSymbolGridTrade: mockDeleteSymbolGridTrade
            }));

            mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);

            jest.mock('../../../trailingTradeHelper/order', () => ({
              getGridTradeOrder: mockGetGridTradeOrder
            }));

            const step = require('../remove-last-buy-price');

            rawData = {
              action: 'not-determined',
              isLocked: false,
              symbol: 'BTCUPUSDT',
              symbolConfiguration: {
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

          it('does not trigger cache.set because autoTriggerBuy is disabled', () => {
            expect(cacheMock.hset).not.toHaveBeenCalled();
          });

          it('returns expected data', () => {
            expect(result).toStrictEqual({
              ...rawData,
              ...{
                sell: {
                  currentPrice: 200,
                  lastBuyPrice: 160,
                  processMessage:
                    'Balance is not enough to sell. Delete last buy price.',
                  updatedAt: expect.any(Object)
                }
              }
            });
          });
        });
      });
    });

    describe('when balance is less than minimum notional', () => {
      describe('when found open orders at this point', () => {
        beforeEach(async () => {
          mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([
            {
              orderId: '123123123'
            }
          ]);

          jest.mock('../../../trailingTradeHelper/common', () => ({
            getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
            isActionDisabled: mockIsActionDisabled,
            getAPILimit: mockGetAPILimit,
            removeLastBuyPrice: mockRemoveLastBuyPrice
          }));

          jest.mock('../../../trailingTradeHelper/configuration', () => ({
            archiveSymbolGridTrade: mockArchiveSymbolGridTrade,
            deleteSymbolGridTrade: mockDeleteSymbolGridTrade
          }));

          mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);

          jest.mock('../../../trailingTradeHelper/order', () => ({
            getGridTradeOrder: mockGetGridTradeOrder
          }));

          const step = require('../remove-last-buy-price');

          rawData = {
            action: 'not-determined',
            isLocked: false,
            symbol: 'BTCUPUSDT',
            symbolConfiguration: {
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
              locked: 0.04
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

        it('returns expected data', () => {
          expect(result).toStrictEqual(rawData);
        });
      });

      describe('when cannot find open orders', () => {
        describe('last buy price remove threshold is same as minimum notional', () => {
          beforeEach(async () => {
            jest.mock('../../../trailingTradeHelper/common', () => ({
              getAndCacheOpenOrdersForSymbol:
                mockGetAndCacheOpenOrdersForSymbol,
              isActionDisabled: mockIsActionDisabled,
              getAPILimit: mockGetAPILimit,
              removeLastBuyPrice: mockRemoveLastBuyPrice
            }));

            mockArchiveSymbolGridTrade = jest.fn().mockResolvedValue({
              profit: -10,
              profitPercentage: -0.1,
              totalBuyQuoteBuy: 110,
              totalSellQuoteQty: 100
            });

            jest.mock('../../../trailingTradeHelper/configuration', () => ({
              archiveSymbolGridTrade: mockArchiveSymbolGridTrade,
              deleteSymbolGridTrade: mockDeleteSymbolGridTrade
            }));

            mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);

            jest.mock('../../../trailingTradeHelper/order', () => ({
              getGridTradeOrder: mockGetGridTradeOrder
            }));

            const step = require('../remove-last-buy-price');

            rawData = {
              action: 'not-determined',
              isLocked: false,
              symbol: 'BTCUPUSDT',
              symbolConfiguration: {
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

          it('triggers cache.set because autoTriggerBuy is enabled', () => {
            expect(cacheMock.hset.mock.calls[0][0]).toStrictEqual(
              'trailing-trade-override'
            );
            expect(cacheMock.hset.mock.calls[0][1]).toStrictEqual('BTCUPUSDT');
            const args = JSON.parse(cacheMock.hset.mock.calls[0][2]);
            expect(args).toStrictEqual({
              action: 'buy',
              actionAt: expect.any(String)
            });
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
              getAndCacheOpenOrdersForSymbol:
                mockGetAndCacheOpenOrdersForSymbol,
              isActionDisabled: mockIsActionDisabled,
              getAPILimit: mockGetAPILimit,
              removeLastBuyPrice: mockRemoveLastBuyPrice
            }));

            mockArchiveSymbolGridTrade = jest.fn().mockResolvedValue({
              profit: 10,
              profitPercentage: 0.1,
              totalBuyQuoteBuy: 100,
              totalSellQuoteQty: 110
            });

            jest.mock('../../../trailingTradeHelper/configuration', () => ({
              archiveSymbolGridTrade: mockArchiveSymbolGridTrade,
              deleteSymbolGridTrade: mockDeleteSymbolGridTrade
            }));

            mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);

            jest.mock('../../../trailingTradeHelper/order', () => ({
              getGridTradeOrder: mockGetGridTradeOrder
            }));

            const step = require('../remove-last-buy-price');

            rawData = {
              action: 'not-determined',
              isLocked: false,
              symbol: 'BTCUPUSDT',
              symbolConfiguration: {
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

          it('does not trigger cache.set', () => {
            expect(cacheMock.hset).not.toHaveBeenCalled();
          });

          it('returns expected data', () => {
            expect(result).toStrictEqual(rawData);
          });
        });
      });
    });

    describe('when there is enough balance', () => {
      beforeEach(async () => {
        jest.mock('../../../trailingTradeHelper/common', () => ({
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
          isActionDisabled: mockIsActionDisabled,
          getAPILimit: mockGetAPILimit,
          removeLastBuyPrice: mockRemoveLastBuyPrice
        }));

        mockArchiveSymbolGridTrade = jest.fn().mockResolvedValue({
          profit: 10,
          profitPercentage: 0.1,
          totalBuyQuoteBuy: 100,
          totalSellQuoteQty: 110
        });

        jest.mock('../../../trailingTradeHelper/configuration', () => ({
          archiveSymbolGridTrade: mockArchiveSymbolGridTrade,
          deleteSymbolGridTrade: mockDeleteSymbolGridTrade
        }));

        mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);

        jest.mock('../../../trailingTradeHelper/order', () => ({
          getGridTradeOrder: mockGetGridTradeOrder
        }));

        const step = require('../remove-last-buy-price');

        rawData = {
          action: 'not-determined',
          isLocked: false,
          symbol: 'BTCUPUSDT',
          symbolConfiguration: {
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

      it('does not trigger cache.set', () => {
        expect(cacheMock.hset).not.toHaveBeenCalled();
      });

      it('returns expected data', () => {
        expect(result).toStrictEqual({
          ...rawData
        });
      });
    });
  });
});
