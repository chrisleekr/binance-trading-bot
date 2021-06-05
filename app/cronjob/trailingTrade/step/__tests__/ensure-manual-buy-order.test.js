/* eslint-disable global-require */
const moment = require('moment');

describe('ensure-manual-buy-order.js', () => {
  let result;
  let rawData;

  let binanceMock;
  let slackMock;
  let loggerMock;
  let cacheMock;
  let PubSubMock;

  let mockGetLastBuyPrice;
  let mockSaveLastBuyPrice;
  let mockGetAPILimit;

  describe('execute', () => {
    beforeEach(() => {
      jest.clearAllMocks().resetModules();
    });

    beforeEach(async () => {
      const {
        binance,
        slack,
        cache,
        logger,
        PubSub
      } = require('../../../../helpers');

      binanceMock = binance;
      slackMock = slack;
      loggerMock = logger;
      cacheMock = cache;
      PubSubMock = PubSub;

      cacheMock.hgetall = jest.fn().mockResolvedValue(null);
      cacheMock.hdel = jest.fn().mockResolvedValue(true);
      cacheMock.hset = jest.fn().mockResolvedValue(true);

      PubSubMock.publish = jest.fn().mockResolvedValue(true);

      slackMock.sendMessage = jest.fn().mockResolvedValue(true);
      binanceMock.client.getOrder = jest.fn().mockResolvedValue([]);

      mockGetLastBuyPrice = jest.fn().mockReturnValue(null);
      mockSaveLastBuyPrice = jest.fn().mockResolvedValue(true);
      mockGetAPILimit = jest.fn().mockResolvedValue(10);
    });

    describe('when manual buy order is not available', () => {
      beforeEach(async () => {
        jest.mock('../../../trailingTradeHelper/common', () => ({
          getLastBuyPrice: mockGetLastBuyPrice,
          saveLastBuyPrice: mockSaveLastBuyPrice,
          getAPILimit: mockGetAPILimit
        }));

        cacheMock.hgetall = jest.fn().mockResolvedValue(null);

        const step = require('../ensure-manual-buy-order');

        rawData = {
          symbol: 'BTCUSDT',
          isLocked: false,
          symbolConfiguration: {
            system: {
              checkManualBuyOrderPeriod: 10
            }
          }
        };

        result = await step.execute(loggerMock, rawData);
      });

      it('does not trigger binance.client.getOrder', () => {
        expect(binanceMock.client.getOrder).not.toHaveBeenCalled();
      });

      it('does not trigger cache.hdel', () => {
        expect(cacheMock.hdel).not.toHaveBeenCalled();
      });

      it('does not trigger saveLastBuyPrice', () => {
        expect(mockSaveLastBuyPrice).not.toHaveBeenCalled();
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({
          symbol: 'BTCUSDT',
          isLocked: false,
          symbolConfiguration: {
            system: {
              checkManualBuyOrderPeriod: 10
            }
          }
        });
      });
    });

    describe('when manual buy order is already filled', () => {
      [
        {
          desc: 'with LIMIT order and has existing last buy price',
          symbol: 'CAKEUSDT',
          lastBuyPriceDoc: {
            lastBuyPrice: 30,
            quantity: 3
          },
          orderId: 159653829,
          cacheResults: {
            159653829: JSON.stringify({
              symbol: 'CAKEUSDT',
              orderId: 159653829,
              executedQty: '1.00000000',
              cummulativeQuoteQty: '19.54900000',
              status: 'FILLED',
              type: 'LIMIT',
              side: 'BUY'
            })
          },
          expectedSaveLastPrice: {
            lastBuyPrice: 27.38725,
            quantity: 4
          }
        },
        {
          desc: 'with MARKET order and has no existing last buy price',
          symbol: 'BNBUSDT',
          lastBuyPriceDoc: null,
          orderId: 2371284112,
          cacheResults: {
            2371284112: JSON.stringify({
              symbol: 'BNBUSDT',
              orderId: 2371284112,
              executedQty: '0.12300000',
              cummulativeQuoteQty: '49.99581000',
              status: 'FILLED',
              type: 'MARKET',
              side: 'BUY',
              fills: [
                {
                  price: '406.47000000',
                  qty: '0.12300000',
                  commission: '0.00009225',
                  commissionAsset: 'BNB',
                  tradeId: 318836332
                }
              ]
            })
          },
          expectedSaveLastPrice: {
            lastBuyPrice: 406.46999999999997,
            quantity: 0.123
          }
        },
        {
          desc: 'with MARKET order and has existing last buy price',
          symbol: 'BNBUSDT',
          lastBuyPriceDoc: {
            lastBuyPrice: 20.782000000000004,
            quantity: 2.405
          },
          orderId: 160868057,
          cacheResults: {
            160868057: JSON.stringify({
              symbol: 'CAKEUSDT',
              orderId: 160868057,
              executedQty: '3.00000000',
              cummulativeQuoteQty: '61.33200000',
              status: 'FILLED',
              type: 'MARKET',
              side: 'BUY',
              fills: [
                {
                  price: '20.44400000',
                  qty: '3.00000000',
                  commission: '0.00010912',
                  commissionAsset: 'BNB',
                  tradeId: 26893880
                }
              ]
            })
          },
          expectedSaveLastPrice: {
            lastBuyPrice: 20.59439592969473,
            quantity: 5.404999999999999
          }
        }
      ].forEach(testData => {
        describe(`${testData.desc}`, () => {
          beforeEach(async () => {
            mockGetLastBuyPrice = jest
              .fn()
              .mockResolvedValue(testData.lastBuyPriceDoc);

            jest.mock('../../../trailingTradeHelper/common', () => ({
              getLastBuyPrice: mockGetLastBuyPrice,
              saveLastBuyPrice: mockSaveLastBuyPrice,
              getAPILimit: mockGetAPILimit
            }));

            cacheMock.hgetall = jest
              .fn()
              .mockResolvedValue(testData.cacheResults);

            const step = require('../ensure-manual-buy-order');

            rawData = {
              symbol: testData.symbol,
              isLocked: false,
              symbolConfiguration: {
                system: {
                  checkManualBuyOrderPeriod: 10
                }
              }
            };

            result = await step.execute(loggerMock, rawData);
          });

          it('triggers saveLastBuyPrice', () => {
            expect(mockSaveLastBuyPrice).toHaveBeenCalledWith(
              loggerMock,
              testData.symbol,
              testData.expectedSaveLastPrice
            );
          });

          it('triggers cache.hdel', () => {
            expect(cacheMock.hdel).toHaveBeenCalledWith(
              `trailing-trade-manual-buy-order-${testData.symbol}`,
              testData.orderId
            );
          });
        });
      });
    });

    describe('when manual buy order is not filled', () => {
      [
        {
          desc: 'with LIMIT order and FILLED',
          symbol: 'CAKEUSDT',
          lastBuyPriceDoc: {
            lastBuyPrice: 30,
            quantity: 3
          },
          orderId: 159653829,
          cacheResults: {
            159653829: JSON.stringify({
              symbol: 'CAKEUSDT',
              orderId: 159653829,
              origQty: '1.00000000',
              executedQty: '1.00000000',
              cummulativeQuoteQty: '19.54900000',
              status: 'NEW',
              type: 'LIMIT',
              side: 'BUY',
              nextCheck: moment()
                .subtract(1, 'minute')
                .format('YYYY-MM-DDTHH:mm:ssZ')
            })
          },
          getOrderResult: {
            symbol: 'CAKEUSDT',
            orderId: 159653829,
            executedQty: '1.00000000',
            cummulativeQuoteQty: '19.54900000',
            status: 'FILLED',
            type: 'LIMIT',
            side: 'BUY'
          },
          expectedSaveLastPrice: {
            lastBuyPrice: 27.38725,
            quantity: 4
          }
        },
        {
          desc: 'with MARKET order and FILLED',
          symbol: 'CAKEUSDT',
          lastBuyPriceDoc: {
            lastBuyPrice: 30,
            quantity: 3
          },
          orderId: 159653829,
          cacheResults: {
            159653829: JSON.stringify({
              symbol: 'CAKEUSDT',
              orderId: 159653829,
              origQty: '1.00000000',
              executedQty: '1.00000000',
              cummulativeQuoteQty: '19.54900000',
              status: 'NEW',
              type: 'MARKET',
              side: 'BUY',
              nextCheck: moment()
                .subtract(5, 'minute')
                .format('YYYY-MM-DDTHH:mm:ssZ')
            })
          },
          getOrderResult: {
            symbol: 'CAKEUSDT',
            orderId: 159653829,
            executedQty: '1.00000000',
            cummulativeQuoteQty: '19.54900000',
            status: 'FILLED',
            type: 'MARKET',
            side: 'BUY'
          },
          expectedSaveLastPrice: {
            lastBuyPrice: 27.38725,
            quantity: 4
          }
        },
        {
          desc: 'with MARKET order and FILLED, but not yet to check',
          symbol: 'CAKEUSDT',
          lastBuyPriceDoc: {
            lastBuyPrice: 30,
            quantity: 3
          },
          orderId: 159653829,
          cacheResults: {
            159653829: JSON.stringify({
              symbol: 'CAKEUSDT',
              orderId: 159653829,
              origQty: '1.00000000',
              executedQty: '1.00000000',
              cummulativeQuoteQty: '19.54900000',
              status: 'NEW',
              type: 'MARKET',
              side: 'BUY',
              nextCheck: moment()
                .add(5, 'minute')
                .format('YYYY-MM-DDTHH:mm:ssZ')
            })
          },
          getOrderResult: {
            symbol: 'CAKEUSDT',
            orderId: 159653829,
            executedQty: '1.00000000',
            cummulativeQuoteQty: '19.54900000',
            status: 'FILLED',
            type: 'MARKET',
            side: 'BUY'
          },
          expectedSaveLastPrice: null
        }
      ].forEach(testData => {
        describe(`${testData.desc}`, () => {
          beforeEach(async () => {
            mockGetLastBuyPrice = jest
              .fn()
              .mockResolvedValue(testData.lastBuyPriceDoc);

            cacheMock.hgetall = jest
              .fn()
              .mockResolvedValue(testData.cacheResults);

            binanceMock.client.getOrder = jest
              .fn()
              .mockResolvedValue(testData.getOrderResult);

            const step = require('../ensure-manual-buy-order');

            rawData = {
              symbol: testData.symbol,
              isLocked: false,
              symbolConfiguration: {
                system: {
                  checkManualBuyOrderPeriod: 10
                }
              }
            };

            result = await step.execute(loggerMock, rawData);
          });

          if (testData.expectedSaveLastPrice) {
            it('triggers saveLastBuyPrice', () => {
              expect(mockSaveLastBuyPrice).toHaveBeenCalledWith(
                loggerMock,
                testData.symbol,
                testData.expectedSaveLastPrice
              );
            });

            it('triggers cache.hdel', () => {
              expect(cacheMock.hdel).toHaveBeenCalledWith(
                `trailing-trade-manual-buy-order-${testData.symbol}`,
                testData.orderId
              );
            });
          } else {
            it('does not trigger saveLastBuyPrice', () => {
              expect(mockSaveLastBuyPrice).not.toHaveBeenCalled();
            });

            it('does not trigger cache.hdel', () => {
              expect(cacheMock.hdel).not.toHaveBeenCalled();
            });
          }

          it('does not trigger cache.hset', () => {
            expect(cacheMock.hset).not.toHaveBeenCalled();
          });
        });
      });

      [
        {
          desc: 'with LIMIT order and CANCELED',
          symbol: 'CAKEUSDT',
          lastBuyPriceDoc: {
            lastBuyPrice: 30,
            quantity: 3
          },
          orderId: 159653829,
          cacheResults: {
            159653829: JSON.stringify({
              symbol: 'CAKEUSDT',
              orderId: 159653829,
              origQty: '1.00000000',
              executedQty: '1.00000000',
              cummulativeQuoteQty: '19.54900000',
              status: 'NEW',
              type: 'LIMIT',
              side: 'BUY',
              nextCheck: moment()
                .subtract(1, 'minute')
                .format('YYYY-MM-DDTHH:mm:ssZ')
            })
          },
          getOrderResult: {
            symbol: 'CAKEUSDT',
            orderId: 159653829,
            executedQty: '1.00000000',
            cummulativeQuoteQty: '19.54900000',
            status: 'CANCELED',
            type: 'LIMIT',
            side: 'BUY'
          }
        },
        {
          desc: 'with LIMIT order and REJECTED',
          symbol: 'CAKEUSDT',
          lastBuyPriceDoc: {
            lastBuyPrice: 30,
            quantity: 3
          },
          orderId: 159653829,
          cacheResults: {
            159653829: JSON.stringify({
              symbol: 'CAKEUSDT',
              orderId: 159653829,
              origQty: '1.00000000',
              executedQty: '1.00000000',
              cummulativeQuoteQty: '19.54900000',
              status: 'NEW',
              type: 'LIMIT',
              side: 'BUY',
              nextCheck: moment()
                .subtract(1, 'minute')
                .format('YYYY-MM-DDTHH:mm:ssZ')
            })
          },
          getOrderResult: {
            symbol: 'CAKEUSDT',
            orderId: 159653829,
            executedQty: '1.00000000',
            cummulativeQuoteQty: '19.54900000',
            status: 'REJECTED',
            type: 'LIMIT',
            side: 'BUY'
          }
        },
        {
          desc: 'with LIMIT order and EXPIRED',
          symbol: 'CAKEUSDT',
          lastBuyPriceDoc: {
            lastBuyPrice: 30,
            quantity: 3
          },
          orderId: 159653829,
          cacheResults: {
            159653829: JSON.stringify({
              symbol: 'CAKEUSDT',
              orderId: 159653829,
              origQty: '1.00000000',
              executedQty: '1.00000000',
              cummulativeQuoteQty: '19.54900000',
              status: 'NEW',
              type: 'LIMIT',
              side: 'BUY',
              nextCheck: moment()
                .subtract(1, 'minute')
                .format('YYYY-MM-DDTHH:mm:ssZ')
            })
          },
          getOrderResult: {
            symbol: 'CAKEUSDT',
            orderId: 159653829,
            executedQty: '1.00000000',
            cummulativeQuoteQty: '19.54900000',
            status: 'EXPIRED',
            type: 'LIMIT',
            side: 'BUY'
          }
        },
        {
          desc: 'with LIMIT order and PENDING_CANCEL',
          symbol: 'CAKEUSDT',
          lastBuyPriceDoc: {
            lastBuyPrice: 30,
            quantity: 3
          },
          orderId: 159653829,
          cacheResults: {
            159653829: JSON.stringify({
              symbol: 'CAKEUSDT',
              orderId: 159653829,
              origQty: '1.00000000',
              executedQty: '1.00000000',
              cummulativeQuoteQty: '19.54900000',
              status: 'NEW',
              type: 'LIMIT',
              side: 'BUY',
              nextCheck: moment()
                .subtract(1, 'minute')
                .format('YYYY-MM-DDTHH:mm:ssZ')
            })
          },
          getOrderResult: {
            symbol: 'CAKEUSDT',
            orderId: 159653829,
            executedQty: '1.00000000',
            cummulativeQuoteQty: '19.54900000',
            status: 'PENDING_CANCEL',
            type: 'LIMIT',
            side: 'BUY'
          }
        },
        {
          desc: 'with LIMIT order and CANCELED',
          symbol: 'CAKEUSDT',
          lastBuyPriceDoc: {
            lastBuyPrice: 30,
            quantity: 3
          },
          orderId: 159653829,
          cacheResults: {
            159653829: JSON.stringify({
              symbol: 'CAKEUSDT',
              orderId: 159653829,
              origQty: '1.00000000',
              executedQty: '1.00000000',
              cummulativeQuoteQty: '19.54900000',
              status: 'NEW',
              type: 'LIMIT',
              side: 'BUY',
              nextCheck: moment()
                .subtract(1, 'minute')
                .format('YYYY-MM-DDTHH:mm:ssZ')
            })
          },
          getOrderResult: {
            symbol: 'CAKEUSDT',
            orderId: 159653829,
            executedQty: '1.00000000',
            cummulativeQuoteQty: '19.54900000',
            status: 'CANCELED',
            type: 'LIMIT',
            side: 'BUY'
          }
        }
      ].forEach(testData => {
        describe(`${testData.desc}`, () => {
          beforeEach(async () => {
            mockGetLastBuyPrice = jest
              .fn()
              .mockResolvedValue(testData.lastBuyPriceDoc);

            cacheMock.hgetall = jest
              .fn()
              .mockResolvedValue(testData.cacheResults);

            binanceMock.client.getOrder = jest
              .fn()
              .mockResolvedValue(testData.getOrderResult);

            const step = require('../ensure-manual-buy-order');

            rawData = {
              symbol: testData.symbol,
              isLocked: false,
              symbolConfiguration: {
                system: {
                  checkManualBuyOrderPeriod: 10
                }
              }
            };

            result = await step.execute(loggerMock, rawData);
          });

          it('does not trigger saveLastBuyPrice', () => {
            expect(mockSaveLastBuyPrice).not.toHaveBeenCalled();
          });

          it('triggers cache.hdel', () => {
            expect(cacheMock.hdel).toHaveBeenCalledWith(
              `trailing-trade-manual-buy-order-${testData.symbol}`,
              testData.orderId
            );
          });
        });
      });

      [
        {
          desc: 'with LIMIT order and still NEW',
          symbol: 'CAKEUSDT',
          lastBuyPriceDoc: {
            lastBuyPrice: 30,
            quantity: 3
          },
          orderId: 159653829,
          cacheResults: {
            159653829: JSON.stringify({
              symbol: 'CAKEUSDT',
              orderId: 159653829,
              origQty: '1.00000000',
              executedQty: '1.00000000',
              cummulativeQuoteQty: '19.54900000',
              status: 'NEW',
              type: 'LIMIT',
              side: 'BUY',
              nextCheck: moment()
                .subtract(1, 'minute')
                .format('YYYY-MM-DDTHH:mm:ssZ')
            })
          },
          getOrderResult: {
            symbol: 'CAKEUSDT',
            orderId: 159653829,
            executedQty: '1.00000000',
            cummulativeQuoteQty: '19.54900000',
            status: 'NEW',
            type: 'LIMIT',
            side: 'BUY'
          }
        }
      ].forEach(testData => {
        describe(`${testData.desc}`, () => {
          beforeEach(async () => {
            mockGetLastBuyPrice = jest
              .fn()
              .mockResolvedValue(testData.lastBuyPriceDoc);

            cacheMock.hgetall = jest
              .fn()
              .mockResolvedValue(testData.cacheResults);

            binanceMock.client.getOrder = jest
              .fn()
              .mockResolvedValue(testData.getOrderResult);

            const step = require('../ensure-manual-buy-order');

            rawData = {
              symbol: testData.symbol,
              isLocked: false,
              symbolConfiguration: {
                system: {
                  checkManualBuyOrderPeriod: 10
                }
              }
            };

            result = await step.execute(loggerMock, rawData);
          });

          it('does not trigger saveLastBuyPrice', () => {
            expect(mockSaveLastBuyPrice).not.toHaveBeenCalled();
          });

          it('does not trigger cache.hdel', () => {
            expect(cacheMock.hdel).not.toHaveBeenCalled();
          });

          it('triggers cache.hset', () => {
            expect(cacheMock.hset).toHaveBeenCalledWith(
              `trailing-trade-manual-buy-order-${testData.symbol}`,
              testData.orderId,
              expect.any(String)
            );
          });
        });
      });

      describe('when binance.client.getOrder throws an error', () => {
        beforeEach(async () => {
          mockGetLastBuyPrice = jest.fn().mockResolvedValue({
            lastBuyPrice: 30,
            quantity: 3
          });

          cacheMock.hgetall = jest.fn().mockResolvedValue({
            159653829: JSON.stringify({
              symbol: 'CAKEUSDT',
              orderId: 159653829,
              origQty: '1.00000000',
              executedQty: '1.00000000',
              cummulativeQuoteQty: '19.54900000',
              status: 'NEW',
              type: 'LIMIT',
              side: 'BUY',
              nextCheck: moment()
                .subtract(1, 'minute')
                .format('YYYY-MM-DDTHH:mm:ssZ')
            })
          });

          binanceMock.client.getOrder = jest
            .fn()
            .mockRejectedValue(new Error('Order is not found.'));

          const step = require('../ensure-manual-buy-order');

          rawData = {
            symbol: 'CAKEUSDT',
            isLocked: false,
            symbolConfiguration: {
              system: {
                checkManualBuyOrderPeriod: 10
              }
            }
          };

          result = await step.execute(loggerMock, rawData);
        });

        it('does not trigger saveLastBuyPrice', () => {
          expect(mockSaveLastBuyPrice).not.toHaveBeenCalled();
        });

        it('does not trigger cache.hdel', () => {
          expect(cacheMock.hdel).not.toHaveBeenCalled();
        });

        it('triggers cache.hset', () => {
          expect(cacheMock.hset).toHaveBeenCalledWith(
            `trailing-trade-manual-buy-order-CAKEUSDT`,
            159653829,
            expect.any(String)
          );
        });
      });
    });
  });
});
