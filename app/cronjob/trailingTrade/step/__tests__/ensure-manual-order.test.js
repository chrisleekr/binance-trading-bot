/* eslint-disable global-require */
describe('ensure-manual-order.js', () => {
  let result;
  let rawData;

  let slackMock;
  let loggerMock;
  let PubSubMock;

  let mockCalculateLastBuyPrice;
  let mockGetAPILimit;
  let mockIsExceedAPILimit;

  let mockGetSymbolGridTrade;
  let mockSaveSymbolGridTrade;

  let mockGetManualOrders;
  let mockDeleteManualOrder;

  describe('execute', () => {
    beforeEach(() => {
      jest.clearAllMocks().resetModules();
    });

    beforeEach(async () => {
      const { slack, logger, PubSub } = require('../../../../helpers');

      slackMock = slack;
      loggerMock = logger;
      PubSubMock = PubSub;

      PubSubMock.publish = jest.fn().mockResolvedValue(true);

      slackMock.sendMessage = jest.fn().mockResolvedValue(true);

      mockCalculateLastBuyPrice = jest.fn().mockResolvedValue(true);
      mockGetAPILimit = jest.fn().mockResolvedValue(10);
      mockIsExceedAPILimit = jest.fn().mockReturnValue(false);

      jest.mock('../../../trailingTradeHelper/common', () => ({
        calculateLastBuyPrice: mockCalculateLastBuyPrice,
        getAPILimit: mockGetAPILimit,
        isExceedAPILimit: mockIsExceedAPILimit
      }));

      mockGetSymbolGridTrade = jest.fn().mockResolvedValue({
        buy: [
          {
            some: 'value'
          }
        ],
        sell: [{ some: 'value' }]
      });
      mockSaveSymbolGridTrade = jest.fn().mockResolvedValue(true);

      mockGetManualOrders = jest.fn().mockResolvedValue(null);
      mockDeleteManualOrder = jest.fn().mockResolvedValue(true);
    });

    describe('when api limit exceeded', () => {
      beforeEach(async () => {
        mockIsExceedAPILimit = jest.fn().mockReturnValue(true);

        jest.mock('../../../trailingTradeHelper/common', () => ({
          calculateLastBuyPrice: mockCalculateLastBuyPrice,
          getAPILimit: mockGetAPILimit,
          isExceedAPILimit: mockIsExceedAPILimit
        }));

        jest.mock('../../../trailingTradeHelper/configuration', () => ({
          getSymbolGridTrade: mockGetSymbolGridTrade,
          saveSymbolGridTrade: mockSaveSymbolGridTrade
        }));

        jest.mock('../../../trailingTradeHelper/order', () => ({
          getManualOrders: mockGetManualOrders,
          deleteManualOrder: mockDeleteManualOrder
        }));

        const step = require('../ensure-manual-order');

        rawData = {
          symbol: 'BTCUSDT',
          isLocked: false,
          featureToggle: { notifyDebug: true },
          symbolConfiguration: {
            system: {
              checkManualOrderPeriod: 10
            }
          }
        };

        result = await step.execute(loggerMock, rawData);
      });

      it('does not trigger deleteManualOrder', () => {
        expect(mockDeleteManualOrder).not.toHaveBeenCalled();
      });

      it('does not trigger saveSymbolGridTrade', () => {
        expect(mockSaveSymbolGridTrade).not.toHaveBeenCalled();
      });

      it('does not trigger calculateLastBuyPrice', () => {
        expect(mockCalculateLastBuyPrice).not.toHaveBeenCalled();
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({
          symbol: 'BTCUSDT',
          isLocked: false,
          featureToggle: { notifyDebug: true },
          symbolConfiguration: {
            system: {
              checkManualOrderPeriod: 10
            }
          }
        });
      });
    });

    describe('when manual buy order is not available', () => {
      beforeEach(async () => {
        jest.mock('../../../trailingTradeHelper/configuration', () => ({
          getSymbolGridTrade: mockGetSymbolGridTrade,
          saveSymbolGridTrade: mockSaveSymbolGridTrade
        }));

        jest.mock('../../../trailingTradeHelper/order', () => ({
          getManualOrders: mockGetManualOrders,
          deleteManualOrder: mockDeleteManualOrder
        }));

        const step = require('../ensure-manual-order');

        rawData = {
          symbol: 'BTCUSDT',
          isLocked: false,
          featureToggle: { notifyDebug: true },
          symbolConfiguration: {
            system: {
              checkManualOrderPeriod: 10
            }
          }
        };

        result = await step.execute(loggerMock, rawData);
      });

      it('does not trigger deleteManualOrder', () => {
        expect(mockDeleteManualOrder).not.toHaveBeenCalled();
      });

      it('does not trigger saveSymbolGridTrade', () => {
        expect(mockSaveSymbolGridTrade).not.toHaveBeenCalled();
      });

      it('does not trigger calculateLastBuyPrice', () => {
        expect(mockCalculateLastBuyPrice).not.toHaveBeenCalled();
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({
          symbol: 'BTCUSDT',
          isLocked: false,
          featureToggle: { notifyDebug: true },
          symbolConfiguration: {
            system: {
              checkManualOrderPeriod: 10
            }
          }
        });
      });
    });

    describe('when manual order is already filled', () => {
      [
        {
          desc: 'with LIMIT order and has existing last buy price',
          symbol: 'CAKEUSDT',
          lastBuyPriceDoc: {
            lastBuyPrice: 30,
            quantity: 3
          },
          featureToggle: { notifyDebug: false },
          orderId: 159653829,
          cacheResults: [
            {
              order: {
                symbol: 'CAKEUSDT',
                orderId: 159653829,
                executedQty: '1.00000000',
                cummulativeQuoteQty: '19.54900000',
                status: 'FILLED',
                type: 'LIMIT',
                side: 'BUY'
              }
            }
          ],
          expectedCalculateLastBuyPrice: true
        },
        {
          desc: 'with MARKET order and has no existing last buy price',
          symbol: 'BNBUSDT',
          lastBuyPriceDoc: null,
          featureToggle: { notifyDebug: true },
          orderId: 2371284112,
          cacheResults: [
            {
              order: {
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
              }
            }
          ],
          expectedCalculateLastBuyPrice: true
        },
        {
          desc: 'with MARKET order and has existing last buy price',
          symbol: 'BNBUSDT',
          lastBuyPriceDoc: {
            lastBuyPrice: 20.782000000000004,
            quantity: 2.405
          },
          featureToggle: { notifyDebug: false },
          orderId: 160868057,
          cacheResults: [
            {
              order: {
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
              }
            }
          ],
          expectedCalculateLastBuyPrice: true
        },
        {
          desc: 'Sell with MARKET order and has existing last buy price',
          symbol: 'BNBUSDT',
          lastBuyPriceDoc: {
            lastBuyPrice: 20.782000000000004,
            quantity: 2.405
          },
          featureToggle: { notifyDebug: false },
          orderId: 160868057,
          cacheResults: [
            {
              order: {
                symbol: 'CAKEUSDT',
                orderId: 160868057,
                executedQty: '3.00000000',
                cummulativeQuoteQty: '61.33200000',
                status: 'FILLED',
                type: 'MARKET',
                side: 'SELL',
                fills: [
                  {
                    price: '20.44400000',
                    qty: '3.00000000',
                    commission: '0.00010912',
                    commissionAsset: 'BNB',
                    tradeId: 26893880
                  }
                ]
              }
            }
          ],
          expectedCalculateLastBuyPrice: false
        }
      ].forEach(testData => {
        describe(`${testData.desc}`, () => {
          beforeEach(async () => {
            jest.mock('../../../trailingTradeHelper/configuration', () => ({
              getSymbolGridTrade: mockGetSymbolGridTrade,
              saveSymbolGridTrade: mockSaveSymbolGridTrade
            }));

            mockGetManualOrders = jest
              .fn()
              .mockResolvedValue(testData.cacheResults);

            jest.mock('../../../trailingTradeHelper/order', () => ({
              getManualOrders: mockGetManualOrders,
              deleteManualOrder: mockDeleteManualOrder
            }));

            const step = require('../ensure-manual-order');

            rawData = {
              symbol: testData.symbol,
              featureToggle: testData.featureToggle,
              isLocked: false,
              symbolConfiguration: {
                system: {
                  checkManualOrderPeriod: 10
                }
              }
            };

            result = await step.execute(loggerMock, rawData);
          });

          if (testData.expectedCalculateLastBuyPrice) {
            it('triggers calculateLastBuyPrice', () => {
              expect(mockCalculateLastBuyPrice).toHaveBeenCalledWith(
                loggerMock,
                testData.symbol,
                testData.cacheResults[0].order
              );
            });
          } else {
            it('does not trigger calculateLastBuyPrice', () => {
              expect(mockCalculateLastBuyPrice).not.toHaveBeenCalled();
            });
          }

          it('triggers deleteManualOrder', () => {
            expect(mockDeleteManualOrder).toHaveBeenCalledWith(
              loggerMock,
              testData.symbol,
              testData.orderId
            );
          });

          it('triggers getSymbolGridTrade', () => {
            expect(mockGetSymbolGridTrade).toHaveBeenCalledWith(
              loggerMock,
              testData.symbol
            );
          });

          it('triggers saveSymbolGridTrade', () => {
            expect(mockSaveSymbolGridTrade).toHaveBeenCalledWith(
              loggerMock,
              testData.symbol,
              {
                buy: [
                  {
                    some: 'value'
                  }
                ],
                sell: [{ some: 'value' }],
                manualTrade: [testData.cacheResults[0].order]
              }
            );
          });
        });
      });
    });

    describe('when manual order is not filled', () => {
      [
        {
          desc: 'with LIMIT order and CANCELED',
          symbol: 'CAKEUSDT',
          orderId: 159653829,
          cacheResults: [
            {
              order: {
                symbol: 'CAKEUSDT',
                orderId: 159653829,
                origQty: '1.00000000',
                executedQty: '1.00000000',
                cummulativeQuoteQty: '19.54900000',
                status: 'CANCELED',
                type: 'LIMIT',
                side: 'BUY'
              }
            }
          ]
        },
        {
          desc: 'with LIMIT order and REJECTED',
          symbol: 'CAKEUSDT',
          orderId: 159653829,
          cacheResults: [
            {
              order: {
                symbol: 'CAKEUSDT',
                orderId: 159653829,
                origQty: '1.00000000',
                executedQty: '1.00000000',
                cummulativeQuoteQty: '19.54900000',
                status: 'REJECTED',
                type: 'LIMIT',
                side: 'BUY'
              }
            }
          ]
        },
        {
          desc: 'with LIMIT order and EXPIRED',
          symbol: 'CAKEUSDT',
          orderId: 159653829,
          cacheResults: [
            {
              order: {
                symbol: 'CAKEUSDT',
                orderId: 159653829,
                origQty: '1.00000000',
                executedQty: '1.00000000',
                cummulativeQuoteQty: '19.54900000',
                status: 'EXPIRED',
                type: 'LIMIT',
                side: 'BUY'
              }
            }
          ]
        },
        {
          desc: 'with LIMIT order and PENDING_CANCEL',
          symbol: 'CAKEUSDT',
          orderId: 159653829,
          cacheResults: [
            {
              order: {
                symbol: 'CAKEUSDT',
                orderId: 159653829,
                origQty: '1.00000000',
                executedQty: '1.00000000',
                cummulativeQuoteQty: '19.54900000',
                status: 'PENDING_CANCEL',
                type: 'LIMIT',
                side: 'BUY'
              }
            }
          ]
        },
        {
          desc: 'with LIMIT order and CANCELED',
          symbol: 'CAKEUSDT',
          orderId: 159653829,
          cacheResults: [
            {
              order: {
                symbol: 'CAKEUSDT',
                orderId: 159653829,
                origQty: '1.00000000',
                executedQty: '1.00000000',
                cummulativeQuoteQty: '19.54900000',
                status: 'CANCELED',
                type: 'LIMIT',
                side: 'BUY'
              }
            }
          ]
        }
      ].forEach(testData => {
        describe(`${testData.desc}`, () => {
          beforeEach(async () => {
            mockGetManualOrders = jest
              .fn()
              .mockResolvedValue(testData.cacheResults);

            jest.mock('../../../trailingTradeHelper/order', () => ({
              getManualOrders: mockGetManualOrders,
              deleteManualOrder: mockDeleteManualOrder
            }));

            const step = require('../ensure-manual-order');

            rawData = {
              symbol: testData.symbol,
              featureToggle: { notifyDebug: true },
              isLocked: false,
              symbolConfiguration: {
                system: {
                  checkManualOrderPeriod: 10
                }
              }
            };

            result = await step.execute(loggerMock, rawData);
          });

          it('does not trigger calculateLastBuyPrice', () => {
            expect(mockCalculateLastBuyPrice).not.toHaveBeenCalled();
          });

          it('triggers deleteManualOrderhdel', () => {
            expect(mockDeleteManualOrder).toHaveBeenCalledWith(
              loggerMock,
              testData.symbol,
              testData.orderId
            );
          });

          it('does not trigger getSymbolGridTrade', () => {
            expect(mockGetSymbolGridTrade).not.toHaveBeenCalled();
          });

          it('does not trigger saveSymbolGridTrade', () => {
            expect(mockSaveSymbolGridTrade).not.toHaveBeenCalled();
          });
        });
      });

      [
        {
          desc: 'with LIMIT order and NEW',
          symbol: 'CAKEUSDT',
          orderId: 159653829,
          cacheResults: [
            {
              order: {
                symbol: 'CAKEUSDT',
                orderId: 159653829,
                origQty: '1.00000000',
                executedQty: '1.00000000',
                cummulativeQuoteQty: '19.54900000',
                status: 'NEW',
                type: 'LIMIT',
                side: 'BUY'
              }
            }
          ]
        }
      ].forEach(testData => {
        describe(`${testData.desc}`, () => {
          beforeEach(async () => {
            mockGetManualOrders = jest
              .fn()
              .mockResolvedValue(testData.cacheResults);

            jest.mock('../../../trailingTradeHelper/order', () => ({
              getManualOrders: mockGetManualOrders,
              deleteManualOrder: mockDeleteManualOrder
            }));

            const step = require('../ensure-manual-order');

            rawData = {
              symbol: testData.symbol,
              featureToggle: { notifyDebug: true },
              isLocked: false,
              symbolConfiguration: {
                system: {
                  checkManualOrderPeriod: 10
                }
              }
            };

            result = await step.execute(loggerMock, rawData);
          });

          it('does not trigger calculateLastBuyPrice', () => {
            expect(mockCalculateLastBuyPrice).not.toHaveBeenCalled();
          });

          it('does not trigger deleteManualOrder', () => {
            expect(mockDeleteManualOrder).not.toHaveBeenCalled();
          });

          it('does not trigger getSymbolGridTrade', () => {
            expect(mockGetSymbolGridTrade).not.toHaveBeenCalled();
          });

          it('does not trigger saveSymbolGridTrade', () => {
            expect(mockSaveSymbolGridTrade).not.toHaveBeenCalled();
          });
        });
      });
    });
  });
});
