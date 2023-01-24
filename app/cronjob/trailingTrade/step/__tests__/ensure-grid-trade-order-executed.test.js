/* eslint-disable no-lonely-if */
/* eslint-disable global-require */

describe('ensure-grid-trade-order-executed.js', () => {
  let result;
  let rawData;

  let slackMock;
  let loggerMock;
  let PubSubMock;

  let mockCalculateLastBuyPrice;
  let mockGetAPILimit;
  let mockIsExceedAPILimit;
  let mockDisableAction;
  let mockSaveOrderStats;
  let mockRefreshOpenOrdersAndAccountInfo;

  let mockSaveSymbolGridTrade;

  let mockGetGridTradeLastOrder;
  let mockDeleteGridTradeOrder;

  describe('execute', () => {
    beforeEach(async () => {
      jest.clearAllMocks().resetModules();

      // Mock moment to return static date
      jest.mock(
        'moment',
        () => nextCheck =>
          jest.requireActual('moment')(nextCheck || '2020-01-02T00:00:00+00:00')
      );

      const { slack, logger, PubSub } = require('../../../../helpers');

      slackMock = slack;
      loggerMock = logger;
      PubSubMock = PubSub;

      PubSubMock.publish = jest.fn().mockResolvedValue(true);

      slackMock.sendMessage = jest.fn().mockResolvedValue(true);

      mockCalculateLastBuyPrice = jest.fn().mockResolvedValue(true);
      mockGetAPILimit = jest.fn().mockReturnValue(10);
      mockIsExceedAPILimit = jest.fn().mockReturnValue(false);
      mockDisableAction = jest.fn().mockResolvedValue(true);
      mockSaveOrderStats = jest.fn().mockResolvedValue(true);
      mockRefreshOpenOrdersAndAccountInfo = jest.fn().mockResolvedValue({
        accountInfo: {
          accountInfo: 'updated'
        },
        openOrders: [{ openOrders: 'retrieved' }],
        buyOpenOrders: [{ buyOpenOrders: 'retrived' }],
        sellOpenOrders: [{ sellOpenOrders: 'retrived' }]
      });

      mockSaveSymbolGridTrade = jest.fn().mockResolvedValue(true);

      mockGetGridTradeLastOrder = jest.fn().mockResolvedValue(null);
      mockDeleteGridTradeOrder = jest.fn().mockResolvedValue(true);
    });

    describe('when api limit is exceed', () => {
      beforeEach(async () => {
        mockIsExceedAPILimit = jest.fn().mockReturnValue(true);

        jest.mock('../../../trailingTradeHelper/common', () => ({
          calculateLastBuyPrice: mockCalculateLastBuyPrice,
          getAPILimit: mockGetAPILimit,
          isExceedAPILimit: mockIsExceedAPILimit,
          disableAction: mockDisableAction,
          saveOrderStats: mockSaveOrderStats,
          refreshOpenOrdersAndAccountInfo: mockRefreshOpenOrdersAndAccountInfo
        }));

        jest.mock('../../../trailingTradeHelper/configuration', () => ({
          saveSymbolGridTrade: mockSaveSymbolGridTrade
        }));

        jest.mock('../../../trailingTradeHelper/order', () => ({
          getGridTradeLastOrder: mockGetGridTradeLastOrder,
          deleteGridTradeOrder: mockDeleteGridTradeOrder
        }));

        const step = require('../ensure-grid-trade-order-executed');

        rawData = {
          symbol: 'BTCUSDT',
          action: 'not-determined',
          featureToggle: { notifyOrderExecute: true, notifyDebug: true },
          symbolConfiguration: {
            symbols: ['BTCUSDT', 'BNBUSDT'],
            buy: {
              gridTrade: [
                {
                  triggerPercentage: 1,
                  stopPercentage: 1.025,
                  limitPercentage: 1.026,
                  maxPurchaseAmount: 10,
                  executed: false,
                  executedOrder: null
                },
                {
                  triggerPercentage: 0.8,
                  stopPercentage: 1.025,
                  limitPercentage: 1.026,
                  maxPurchaseAmount: 10,
                  executed: false,
                  executedOrder: null
                }
              ]
            },
            sell: {
              gridTrade: [
                {
                  triggerPercentage: 1.03,
                  stopPercentage: 0.985,
                  limitPercentage: 0.984,
                  quantityPercentage: 0.8,
                  executed: false,
                  executedOrder: null
                },
                {
                  triggerPercentage: 1.05,
                  stopPercentage: 0.975,
                  limitPercentage: 0.974,
                  quantityPercentage: 1,
                  executed: false,
                  executedOrder: null
                }
              ]
            },
            system: {
              checkOrderExecutePeriod: 10,
              temporaryDisableActionAfterConfirmingOrder: 20
            }
          }
        };

        result = await step.execute(loggerMock, rawData);
      });

      it('does not trigger getGridTradeLastOrder', () => {
        expect(mockGetGridTradeLastOrder).not.toHaveBeenCalled();
      });

      it('does not trigger deleteGridTradeOrder', () => {
        expect(mockDeleteGridTradeOrder).not.toHaveBeenCalled();
      });

      it('does not trigger disableAction', () => {
        expect(mockDisableAction).not.toHaveBeenCalled();
      });

      it('does not trigger saveOrderStats', () => {
        expect(mockSaveOrderStats).not.toHaveBeenCalled();
      });

      it('does not trigger refreshOpenOrdersAndAccountInfo', () => {
        expect(mockRefreshOpenOrdersAndAccountInfo).not.toHaveBeenCalled();
      });

      it('does not trigger slack.sendMessage', () => {
        expect(slackMock.sendMessage).not.toHaveBeenCalled();
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual(rawData);
      });
    });

    describe('when found last buy order', () => {
      [
        {
          desc: 'last buy order is empty',
          symbol: 'BNBUSDT',
          lastBuyOrder: null,
          saveSymbolGridTrade: null
        },
        {
          desc: 'last buy order is PARTIALLY_FILLED - currentGridTradeIndex: 0',
          symbol: 'BNBUSDT',
          notifyDebug: true,
          notifyOrderExecute: true,
          lastBuyOrder: {
            symbol: 'BNBUSDT',
            side: 'BUY',
            status: 'PARTIALLY_FILLED',
            type: 'STOP_LOSS_LIMIT',
            orderId: 2705449295,
            price: '302.09000000',
            origQty: '0.03320000',
            stopPrice: '301.80000000',
            currentGridTradeIndex: 0
          },
          saveSymbolGridTrade: {
            buy: [
              {
                executed: true,
                executedOrder: {
                  currentGridTradeIndex: 0,
                  orderId: 2705449295,
                  origQty: '0.03320000',
                  price: '302.09000000',
                  side: 'BUY',
                  status: 'PARTIALLY_FILLED',
                  stopPrice: '301.80000000',
                  symbol: 'BNBUSDT',
                  type: 'STOP_LOSS_LIMIT'
                },
                limitPercentage: 1.026,
                maxPurchaseAmount: 10,
                stopPercentage: 1.025,
                triggerPercentage: 1
              },
              {
                executed: false,
                executedOrder: null,
                limitPercentage: 1.026,
                maxPurchaseAmount: 10,
                stopPercentage: 1.025,
                triggerPercentage: 0.8
              }
            ],
            sell: [
              {
                executed: false,
                executedOrder: null,
                limitPercentage: 0.984,
                quantityPercentage: 0.8,
                stopPercentage: 0.985,
                triggerPercentage: 1.03
              },
              {
                executed: false,
                executedOrder: null,
                limitPercentage: 0.974,
                quantityPercentage: 1,
                stopPercentage: 0.975,
                triggerPercentage: 1.05
              }
            ]
          }
        },
        {
          desc: 'last buy order is FILLED - currentGridTradeIndex: 0',
          symbol: 'BNBUSDT',
          notifyDebug: true,
          notifyOrderExecute: true,
          lastBuyOrder: {
            symbol: 'BNBUSDT',
            side: 'BUY',
            status: 'FILLED',
            type: 'STOP_LOSS_LIMIT',
            orderId: 2705449295,
            price: '302.09000000',
            origQty: '0.03320000',
            stopPrice: '301.80000000',
            currentGridTradeIndex: 0
          },
          saveSymbolGridTrade: {
            buy: [
              {
                executed: true,
                executedOrder: {
                  currentGridTradeIndex: 0,
                  orderId: 2705449295,
                  origQty: '0.03320000',
                  price: '302.09000000',
                  side: 'BUY',
                  status: 'FILLED',
                  stopPrice: '301.80000000',
                  symbol: 'BNBUSDT',
                  type: 'STOP_LOSS_LIMIT'
                },
                limitPercentage: 1.026,
                maxPurchaseAmount: 10,
                stopPercentage: 1.025,
                triggerPercentage: 1
              },
              {
                executed: false,
                executedOrder: null,
                limitPercentage: 1.026,
                maxPurchaseAmount: 10,
                stopPercentage: 1.025,
                triggerPercentage: 0.8
              }
            ],
            sell: [
              {
                executed: false,
                executedOrder: null,
                limitPercentage: 0.984,
                quantityPercentage: 0.8,
                stopPercentage: 0.985,
                triggerPercentage: 1.03
              },
              {
                executed: false,
                executedOrder: null,
                limitPercentage: 0.974,
                quantityPercentage: 1,
                stopPercentage: 0.975,
                triggerPercentage: 1.05
              }
            ]
          }
        },
        {
          desc: 'last buy order is FILLED - currentGridTradeIndex: 1',
          symbol: 'BNBUSDT',
          notifyDebug: false,
          notifyOrderExecute: false,
          lastBuyOrder: {
            symbol: 'BNBUSDT',
            side: 'BUY',
            status: 'FILLED',
            type: 'STOP_LOSS_LIMIT',
            orderId: 2705449295,
            price: '302.09000000',
            origQty: '0.03320000',
            stopPrice: '301.80000000',
            currentGridTradeIndex: 1
          },
          saveSymbolGridTrade: {
            buy: [
              {
                executed: false,
                executedOrder: null,
                limitPercentage: 1.026,
                maxPurchaseAmount: 10,
                stopPercentage: 1.025,
                triggerPercentage: 1
              },
              {
                executed: true,
                executedOrder: {
                  currentGridTradeIndex: 1,
                  orderId: 2705449295,
                  origQty: '0.03320000',
                  price: '302.09000000',
                  side: 'BUY',
                  status: 'FILLED',
                  stopPrice: '301.80000000',
                  symbol: 'BNBUSDT',
                  type: 'STOP_LOSS_LIMIT'
                },
                limitPercentage: 1.026,
                maxPurchaseAmount: 10,
                stopPercentage: 1.025,
                triggerPercentage: 0.8
              }
            ],
            sell: [
              {
                executed: false,
                executedOrder: null,
                limitPercentage: 0.984,
                quantityPercentage: 0.8,
                stopPercentage: 0.985,
                triggerPercentage: 1.03
              },
              {
                executed: false,
                executedOrder: null,
                limitPercentage: 0.974,
                quantityPercentage: 1,
                stopPercentage: 0.975,
                triggerPercentage: 1.05
              }
            ]
          }
        },
        {
          desc: 'last buy order is NEW',
          symbol: 'BNBUSDT',
          lastBuyOrder: {
            symbol: 'BNBUSDT',
            side: 'BUY',
            status: 'NEW',
            type: 'STOP_LOSS_LIMIT',
            orderId: 2705449295,
            price: '302.09000000',
            origQty: '0.03320000',
            stopPrice: '301.80000000',
            currentGridTradeIndex: 0
          },
          saveSymbolGridTrade: null
        },
        ...['CANCELED', 'REJECTED', 'EXPIRED', 'PENDING_CANCEL'].map(
          status => ({
            desc: `last buy order is ${status}`,
            symbol: 'BNBUSDT',
            lastBuyOrder: {
              symbol: 'BNBUSDT',
              side: 'BUY',
              status,
              type: 'STOP_LOSS_LIMIT',
              orderId: 2705449295,
              price: '302.09000000',
              origQty: '0.03320000',
              stopPrice: '301.80000000',
              currentGridTradeIndex: 0
            },
            saveSymbolGridTrade: null
          })
        )
      ].forEach(t => {
        describe(`${t.desc}`, () => {
          beforeEach(async () => {
            jest.mock('../../../trailingTradeHelper/common', () => ({
              calculateLastBuyPrice: mockCalculateLastBuyPrice,
              getAPILimit: mockGetAPILimit,
              isExceedAPILimit: mockIsExceedAPILimit,
              disableAction: mockDisableAction,
              saveOrderStats: mockSaveOrderStats,
              refreshOpenOrdersAndAccountInfo:
                mockRefreshOpenOrdersAndAccountInfo
            }));

            jest.mock('../../../trailingTradeHelper/configuration', () => ({
              saveSymbolGridTrade: mockSaveSymbolGridTrade
            }));

            mockGetGridTradeLastOrder = jest
              .fn()
              .mockImplementation((_logger, symbol, side) => {
                if (
                  `${t.symbol}-grid-trade-last-buy-order` ===
                  `${symbol}-grid-trade-last-${side}-order`
                ) {
                  return t.lastBuyOrder;
                }

                return null;
              });

            jest.mock('../../../trailingTradeHelper/order', () => ({
              getGridTradeLastOrder: mockGetGridTradeLastOrder,
              deleteGridTradeOrder: mockDeleteGridTradeOrder
            }));

            const step = require('../ensure-grid-trade-order-executed');

            rawData = {
              symbol: t.symbol,
              action: 'not-determined',
              featureToggle: {
                notifyOrderExecute: t.notifyOrderExecute || false,
                notifyDebug: t.notifyDebug || false
              },
              symbolConfiguration: {
                symbols: ['BTCUSDT', 'BNBUSDT'],
                buy: {
                  gridTrade: [
                    {
                      triggerPercentage: 1,
                      stopPercentage: 1.025,
                      limitPercentage: 1.026,
                      maxPurchaseAmount: 10,
                      executed: false,
                      executedOrder: null
                    },
                    {
                      triggerPercentage: 0.8,
                      stopPercentage: 1.025,
                      limitPercentage: 1.026,
                      maxPurchaseAmount: 10,
                      executed: false,
                      executedOrder: null
                    }
                  ]
                },
                sell: {
                  gridTrade: [
                    {
                      triggerPercentage: 1.03,
                      stopPercentage: 0.985,
                      limitPercentage: 0.984,
                      quantityPercentage: 0.8,
                      executed: false,
                      executedOrder: null
                    },
                    {
                      triggerPercentage: 1.05,
                      stopPercentage: 0.975,
                      limitPercentage: 0.974,
                      quantityPercentage: 1,
                      executed: false,
                      executedOrder: null
                    }
                  ]
                },
                system: {
                  checkOrderExecutePeriod: 10,
                  temporaryDisableActionAfterConfirmingOrder: 20
                }
              },
              openOrders: [],
              buy: {
                openOrders: []
              },
              sell: {
                openOrders: []
              }
            };

            result = await step.execute(loggerMock, rawData);
          });

          it('triggers getGridTradeOrder for getting cached order', () => {
            expect(mockGetGridTradeLastOrder).toHaveBeenCalledWith(
              loggerMock,
              t.symbol,
              'buy'
            );
          });

          if (t.lastBuyOrder === null) {
            // If last order is not found
            it('does not trigger deleteGridTradeOrder as order not found', () => {
              expect(mockDeleteGridTradeOrder).not.toHaveBeenCalled();
            });

            it('does not trigger saveSymbolGridTrade', () => {
              expect(mockSaveSymbolGridTrade).not.toHaveBeenCalled();
            });

            it('does not trigger disableAction', () => {
              expect(mockDisableAction).not.toHaveBeenCalled();
            });

            it('does not trigger saveOrderStats', () => {
              expect(mockSaveOrderStats).not.toHaveBeenCalled();
            });

            it('does not trigger refreshOpenOrdersAndAccountInfo', () => {
              expect(
                mockRefreshOpenOrdersAndAccountInfo
              ).not.toHaveBeenCalled();
            });
          } else if (t.lastBuyOrder.status.includes('PARTIALLY_FILLED')) {
            // do filled thing
            it('triggers calculated last buy price as order partially filled', () => {
              expect(mockCalculateLastBuyPrice).toHaveBeenCalledWith(
                loggerMock,
                t.symbol,
                t.lastBuyOrder
              );
            });

            it('triggers save symbol grid trade as order partially filled', () => {
              expect(mockSaveSymbolGridTrade).toHaveBeenCalledWith(
                loggerMock,
                t.symbol,
                t.saveSymbolGridTrade
              );
            });

            it('dows not trigger deleteGridTradeOrder as order partially filled', () => {
              expect(mockDeleteGridTradeOrder).not.toHaveBeenCalled();
            });

            it('dows not trigger disableAction as order partially filled', () => {
              expect(mockDisableAction).not.toHaveBeenCalled();
            });

            it('triggers refreshOpenOrdersAndAccountInfo as order partially filled', () => {
              expect(mockRefreshOpenOrdersAndAccountInfo).toHaveBeenCalledWith(
                loggerMock,
                t.symbol
              );
            });

            it('does not trigger PubSub.publish for check-open-orders channel', () => {
              expect(PubSubMock.publish).not.toHaveBeenCalled();
            });

            it('does not trigger saveOrderStats as order partially filled', () => {
              expect(mockSaveOrderStats).not.toHaveBeenCalled();
            });

            it('triggers slack.sendMessage due to partially filled order', () => {
              expect(slackMock.sendMessage).toHaveBeenCalledWith(
                expect.not.stringContaining('Order Updated'),
                {
                  apiLimit: 10,
                  symbol: t.symbol
                }
              );
            });
          } else if (t.lastBuyOrder.status.includes('FILLED')) {
            // do filled thing
            it('triggers calculated last buy price as order filled', () => {
              expect(mockCalculateLastBuyPrice).toHaveBeenCalledWith(
                loggerMock,
                t.symbol,
                t.lastBuyOrder
              );
            });

            it('triggers save symbol grid trade as order filled', () => {
              expect(mockSaveSymbolGridTrade).toHaveBeenCalledWith(
                loggerMock,
                t.symbol,
                t.saveSymbolGridTrade
              );
            });

            it('triggers deleteGridTradeOrder as order filled', () => {
              expect(mockDeleteGridTradeOrder).toHaveBeenCalledWith(
                loggerMock,
                `${t.symbol}-grid-trade-last-buy-order`
              );
            });

            it('triggers disableAction as order filled', () => {
              expect(mockDisableAction).toHaveBeenCalledWith(
                loggerMock,
                t.symbol,
                {
                  disabledBy: 'buy filled order',
                  message:
                    'Disabled action after confirming filled grid trade order.',
                  canResume: false,
                  canRemoveLastBuyPrice: false
                },
                20
              );
            });

            it('triggers refreshOpenOrdersAndAccountInfo as order filled', () => {
              expect(mockRefreshOpenOrdersAndAccountInfo).toHaveBeenCalledWith(
                loggerMock,
                t.symbol
              );
            });

            it('triggers PubSub.publish for check-open-orders channel', () => {
              expect(PubSubMock.publish).toHaveBeenCalledWith(
                'check-open-orders',
                {}
              );
            });

            it('triggers saveOrderStats', () => {
              expect(mockSaveOrderStats).toHaveBeenCalledWith(loggerMock, [
                'BTCUSDT',
                'BNBUSDT'
              ]);
            });

            if (t.notifyOrderExecute === true) {
              it('triggers slack.sendMessage due to filled order', () => {
                expect(slackMock.sendMessage).toHaveBeenCalledWith(
                  expect.stringContaining('Order Filled'),
                  {
                    apiLimit: 10,
                    symbol: t.symbol
                  }
                );
              });
            } else {
              it('does not trigger slack.sendMessage due to filled order', () => {
                expect(slackMock.sendMessage).not.toHaveBeenCalledWith(
                  expect.stringContaining('Order Filled'),
                  {
                    apiLimit: 10,
                    symbol: t.symbol
                  }
                );
              });
            }
          } else if (
            ['CANCELED', 'REJECTED', 'EXPIRED', 'PENDING_CANCEL'].includes(
              t.lastBuyOrder.status
            ) === true
          ) {
            // do cancel thing
            it('triggers deleteGridTradeOrder due to cancelled order', () => {
              expect(mockDeleteGridTradeOrder).toHaveBeenCalledWith(
                loggerMock,
                `${t.symbol}-grid-trade-last-buy-order`
              );
            });

            it('does not trigger saveSymbolGridTrade due to cancelled order', () => {
              expect(mockSaveSymbolGridTrade).not.toHaveBeenCalled();
            });

            it('does not trigger disableAction due to cancelled order', () => {
              expect(mockDisableAction).not.toHaveBeenCalled();
            });

            it('triggers saveOrderStats due to cancelled order', () => {
              expect(mockSaveOrderStats).toHaveBeenCalledWith(loggerMock, [
                'BTCUSDT',
                'BNBUSDT'
              ]);
            });

            it('triggers refreshOpenOrdersAndAccountInfo due to cancelled order', () => {
              expect(mockRefreshOpenOrdersAndAccountInfo).toHaveBeenCalledWith(
                loggerMock,
                t.symbol
              );
            });

            if (t.notifyOrderExecute === true) {
              it('triggers slack.sendMessage due to cancelled order', () => {
                expect(slackMock.sendMessage).toHaveBeenCalledWith(
                  expect.stringContaining('Order Removed'),
                  {
                    apiLimit: 10,
                    symbol: t.symbol
                  }
                );
              });
            } else {
              it('does not trigger slack.sendMessage due to cancelled order', () => {
                expect(slackMock.sendMessage).not.toHaveBeenCalledWith(
                  expect.stringContaining('Order Removed'),
                  {
                    apiLimit: 10,
                    symbol: t.symbol
                  }
                );
              });
            }
          }

          it('returns result', () => {
            expect(result).toStrictEqual(rawData);
          });
        });
      });
    });

    describe('when found last sell order', () => {
      [
        {
          desc: 'last sell order is empty',
          symbol: 'BNBUSDT',
          lastSellOrder: null,
          getOrder: null,
          saveSymbolGridTrade: null
        },
        {
          desc: 'last sell order is PARTIALLY_FILLED - currentGridTradeIndex: 0',
          symbol: 'BNBUSDT',
          notifyDebug: true,
          lastSellOrder: {
            symbol: 'BNBUSDT',
            side: 'SELL',
            status: 'PARTIALLY_FILLED',
            type: 'STOP_LOSS_LIMIT',
            orderId: 2705449295,
            price: '302.09000000',
            origQty: '0.03320000',
            stopPrice: '301.80000000',
            currentGridTradeIndex: 0
          },
          saveSymbolGridTrade: {
            buy: [
              {
                executed: false,
                executedOrder: null,
                limitPercentage: 1.026,
                maxPurchaseAmount: 10,
                stopPercentage: 1.025,
                triggerPercentage: 1
              },
              {
                executed: false,
                executedOrder: null,
                limitPercentage: 1.026,
                maxPurchaseAmount: 10,
                stopPercentage: 1.025,
                triggerPercentage: 0.8
              }
            ],
            sell: [
              {
                executed: true,
                executedOrder: {
                  currentGridTradeIndex: 0,
                  orderId: 2705449295,
                  origQty: '0.03320000',
                  price: '302.09000000',
                  side: 'SELL',
                  status: 'PARTIALLY_FILLED',
                  stopPrice: '301.80000000',
                  symbol: 'BNBUSDT',
                  type: 'STOP_LOSS_LIMIT'
                },
                limitPercentage: 0.984,
                quantityPercentage: 0.8,
                stopPercentage: 0.985,
                triggerPercentage: 1.03
              },
              {
                executed: false,
                executedOrder: null,
                limitPercentage: 0.974,
                quantityPercentage: 1,
                stopPercentage: 0.975,
                triggerPercentage: 1.05
              }
            ]
          }
        },
        {
          desc: 'last sell order is FILLED - currentGridTradeIndex: 0',
          symbol: 'BNBUSDT',
          notifyDebug: true,
          lastSellOrder: {
            symbol: 'BNBUSDT',
            side: 'SELL',
            status: 'FILLED',
            type: 'STOP_LOSS_LIMIT',
            orderId: 2705449295,
            price: '302.09000000',
            origQty: '0.03320000',
            stopPrice: '301.80000000',
            currentGridTradeIndex: 0
          },
          saveSymbolGridTrade: {
            buy: [
              {
                executed: false,
                executedOrder: null,
                limitPercentage: 1.026,
                maxPurchaseAmount: 10,
                stopPercentage: 1.025,
                triggerPercentage: 1
              },
              {
                executed: false,
                executedOrder: null,
                limitPercentage: 1.026,
                maxPurchaseAmount: 10,
                stopPercentage: 1.025,
                triggerPercentage: 0.8
              }
            ],
            sell: [
              {
                executed: true,
                executedOrder: {
                  currentGridTradeIndex: 0,
                  orderId: 2705449295,
                  origQty: '0.03320000',
                  price: '302.09000000',
                  side: 'SELL',
                  status: 'FILLED',
                  stopPrice: '301.80000000',
                  symbol: 'BNBUSDT',
                  type: 'STOP_LOSS_LIMIT'
                },
                limitPercentage: 0.984,
                quantityPercentage: 0.8,
                stopPercentage: 0.985,
                triggerPercentage: 1.03
              },
              {
                executed: false,
                executedOrder: null,
                limitPercentage: 0.974,
                quantityPercentage: 1,
                stopPercentage: 0.975,
                triggerPercentage: 1.05
              }
            ]
          }
        },
        {
          desc: 'last sell order is FILLED - currentGridTradeIndex: 1',
          symbol: 'BNBUSDT',
          notifyDebug: true,
          lastSellOrder: {
            symbol: 'BNBUSDT',
            side: 'SELL',
            status: 'FILLED',
            type: 'STOP_LOSS_LIMIT',
            orderId: 2705449295,
            price: '302.09000000',
            origQty: '0.03320000',
            stopPrice: '301.80000000',
            currentGridTradeIndex: 1
          },
          saveSymbolGridTrade: {
            buy: [
              {
                executed: false,
                executedOrder: null,
                limitPercentage: 1.026,
                maxPurchaseAmount: 10,
                stopPercentage: 1.025,
                triggerPercentage: 1
              },
              {
                executed: false,
                executedOrder: null,
                limitPercentage: 1.026,
                maxPurchaseAmount: 10,
                stopPercentage: 1.025,
                triggerPercentage: 0.8
              }
            ],
            sell: [
              {
                executed: false,
                executedOrder: null,
                limitPercentage: 0.984,
                quantityPercentage: 0.8,
                stopPercentage: 0.985,
                triggerPercentage: 1.03
              },
              {
                executed: true,
                executedOrder: {
                  currentGridTradeIndex: 1,
                  orderId: 2705449295,
                  origQty: '0.03320000',
                  price: '302.09000000',
                  side: 'SELL',
                  status: 'FILLED',
                  stopPrice: '301.80000000',
                  symbol: 'BNBUSDT',
                  type: 'STOP_LOSS_LIMIT'
                },
                limitPercentage: 0.974,
                quantityPercentage: 1,
                stopPercentage: 0.975,
                triggerPercentage: 1.05
              }
            ]
          }
        },
        {
          desc: 'last sell order is NEW',
          symbol: 'BNBUSDT',
          lastSellOrder: {
            symbol: 'BNBUSDT',
            side: 'SELL',
            status: 'NEW',
            type: 'STOP_LOSS_LIMIT',
            orderId: 2705449295,
            price: '302.09000000',
            origQty: '0.03320000',
            stopPrice: '301.80000000',
            currentGridTradeIndex: 0
          },
          saveSymbolGridTrade: null
        },
        ...['CANCELED', 'REJECTED', 'EXPIRED', 'PENDING_CANCEL'].map(
          status => ({
            desc: `last sell order is ${status}`,
            symbol: 'BNBUSDT',
            lastSellOrder: {
              symbol: 'BNBUSDT',
              side: 'SELL',
              status,
              type: 'STOP_LOSS_LIMIT',
              orderId: 2705449295,
              price: '302.09000000',
              origQty: '0.03320000',
              stopPrice: '301.80000000',
              currentGridTradeIndex: 0
            },
            saveSymbolGridTrade: null
          })
        )
      ].forEach((t, index) => {
        describe(`${t.desc}`, () => {
          beforeEach(async () => {
            jest.mock('../../../trailingTradeHelper/common', () => ({
              calculateLastBuyPrice: mockCalculateLastBuyPrice,
              getAPILimit: mockGetAPILimit,
              isExceedAPILimit: mockIsExceedAPILimit,
              disableAction: mockDisableAction,
              saveOrderStats: mockSaveOrderStats,
              refreshOpenOrdersAndAccountInfo:
                mockRefreshOpenOrdersAndAccountInfo
            }));

            jest.mock('../../../trailingTradeHelper/configuration', () => ({
              saveSymbolGridTrade: mockSaveSymbolGridTrade
            }));

            mockGetGridTradeLastOrder = jest
              .fn()
              .mockImplementation((_logger, symbol, side) => {
                if (
                  `${t.symbol}-grid-trade-last-sell-order` ===
                  `${symbol}-grid-trade-last-${side}-order`
                ) {
                  return t.lastSellOrder;
                }

                return null;
              });

            jest.mock('../../../trailingTradeHelper/order', () => ({
              getGridTradeLastOrder: mockGetGridTradeLastOrder,
              deleteGridTradeOrder: mockDeleteGridTradeOrder
            }));

            const step = require('../ensure-grid-trade-order-executed');

            rawData = {
              symbol: t.symbol,
              action: 'not-determined',
              featureToggle: {
                notifyOrderExecute: true,
                notifyDebug: index % 2
              },
              symbolConfiguration: {
                symbols: ['BTCUSDT', 'BNBUSDT'],
                buy: {
                  gridTrade: [
                    {
                      triggerPercentage: 1,
                      stopPercentage: 1.025,
                      limitPercentage: 1.026,
                      maxPurchaseAmount: 10,
                      executed: false,
                      executedOrder: null
                    },
                    {
                      triggerPercentage: 0.8,
                      stopPercentage: 1.025,
                      limitPercentage: 1.026,
                      maxPurchaseAmount: 10,
                      executed: false,
                      executedOrder: null
                    }
                  ]
                },
                sell: {
                  gridTrade: [
                    {
                      triggerPercentage: 1.03,
                      stopPercentage: 0.985,
                      limitPercentage: 0.984,
                      quantityPercentage: 0.8,
                      executed: false,
                      executedOrder: null
                    },
                    {
                      triggerPercentage: 1.05,
                      stopPercentage: 0.975,
                      limitPercentage: 0.974,
                      quantityPercentage: 1,
                      executed: false,
                      executedOrder: null
                    }
                  ]
                },
                system: {
                  checkOrderExecutePeriod: 10,
                  temporaryDisableActionAfterConfirmingOrder: 20
                }
              },
              openOrders: [],
              buy: {
                openOrders: []
              },
              sell: {
                openOrders: []
              }
            };

            result = await step.execute(loggerMock, rawData);
          });

          it('triggers getGridTradeOrder for getting cached order', () => {
            expect(mockGetGridTradeLastOrder).toHaveBeenCalledWith(
              loggerMock,
              t.symbol,
              'sell'
            );
          });

          if (t.lastSellOrder === null) {
            // If last order is not found
            it('does not trigger deleteGridTradeOrder as order not found', () => {
              expect(mockDeleteGridTradeOrder).not.toHaveBeenCalled();
            });

            it('does not trigger disableAction', () => {
              expect(mockDisableAction).not.toHaveBeenCalled();
            });

            it('does not trigger saveOrderStats', () => {
              expect(mockSaveOrderStats).not.toHaveBeenCalled();
            });
          } else if (t.lastSellOrder.status.includes('PARTIALLY_FILLED')) {
            // do filled thing

            it('triggers save symbol grid trade as order partially filled', () => {
              expect(mockSaveSymbolGridTrade).toHaveBeenCalledWith(
                loggerMock,
                t.symbol,
                t.saveSymbolGridTrade
              );
            });

            it('does not trigger deleteGridTradeOrder as order partially filled', () => {
              expect(mockDeleteGridTradeOrder).not.toHaveBeenCalled();
            });

            it('triggers refreshOpenOrdersAndAccountInfo as order partially filled', () => {
              expect(mockRefreshOpenOrdersAndAccountInfo).toHaveBeenCalledWith(
                loggerMock,
                t.symbol
              );
            });

            it('does not trigger disableAction as order partially filled', () => {
              expect(mockDisableAction).not.toHaveBeenCalled();
            });

            it('does not trigger saveOrderStats as order partially filled', () => {
              expect(mockSaveOrderStats).not.toHaveBeenCalled();
            });

            it('triggers slack.sendMessage due to partially filled order', () => {
              expect(slackMock.sendMessage).toHaveBeenCalledWith(
                expect.not.stringContaining('Order Updated'),
                {
                  apiLimit: 10,
                  symbol: t.symbol
                }
              );
            });
          } else if (t.lastSellOrder.status.includes('FILLED')) {
            // do filled thing

            it('triggers save symbol grid trade as order filled', () => {
              expect(mockSaveSymbolGridTrade).toHaveBeenCalledWith(
                loggerMock,
                t.symbol,
                t.saveSymbolGridTrade
              );
            });

            it('triggers deleteGridTradeOrder as order filled', () => {
              expect(mockDeleteGridTradeOrder).toHaveBeenCalledWith(
                loggerMock,
                `${t.symbol}-grid-trade-last-sell-order`
              );
            });

            it('triggers refreshOpenOrdersAndAccountInfo as order filled', () => {
              expect(mockRefreshOpenOrdersAndAccountInfo).toHaveBeenCalledWith(
                loggerMock,
                t.symbol
              );
            });

            it('triggers disableAction as order filled', () => {
              expect(mockDisableAction).toHaveBeenCalledWith(
                loggerMock,
                t.symbol,
                {
                  disabledBy: 'sell filled order',
                  message:
                    'Disabled action after confirming filled grid trade order.',
                  canResume: false,
                  canRemoveLastBuyPrice: true
                },
                20
              );
            });

            it('triggers saveOrderStats', () => {
              expect(mockSaveOrderStats).toHaveBeenCalledWith(loggerMock, [
                'BTCUSDT',
                'BNBUSDT'
              ]);
            });

            it('triggers slack.sendMessage due to filled order', () => {
              expect(slackMock.sendMessage).toHaveBeenCalledWith(
                expect.stringContaining('Order Filled'),
                {
                  apiLimit: 10,
                  symbol: t.symbol
                }
              );
            });
          } else if (
            ['CANCELED', 'REJECTED', 'EXPIRED', 'PENDING_CANCEL'].includes(
              t.lastSellOrder.status
            ) === true
          ) {
            // do cancel thing
            it('triggers deleteGridTradeOrder due to cancelled order', () => {
              expect(mockDeleteGridTradeOrder).toHaveBeenCalledWith(
                loggerMock,
                `${t.symbol}-grid-trade-last-sell-order`
              );
            });

            it('does not trigger saveSymbolGridTrade due to cancelled order', () => {
              expect(mockSaveSymbolGridTrade).not.toHaveBeenCalled();
            });

            it('does not trigger disableAction due to cancelled order', () => {
              expect(mockDisableAction).not.toHaveBeenCalled();
            });

            it('triggers saveOrderStats due to cancelled order', () => {
              expect(mockSaveOrderStats).toHaveBeenCalledWith(loggerMock, [
                'BTCUSDT',
                'BNBUSDT'
              ]);
            });

            it('triggers refreshOpenOrdersAndAccountInfo due to cancelled order', () => {
              expect(mockRefreshOpenOrdersAndAccountInfo).toHaveBeenCalledWith(
                loggerMock,
                t.symbol
              );
            });

            it('triggers slack.sendMessage due to cancelled order', () => {
              expect(slackMock.sendMessage).toHaveBeenCalledWith(
                expect.stringContaining('Order Removed'),
                {
                  apiLimit: 10,
                  symbol: t.symbol
                }
              );
            });
          }

          it('returns result', () => {
            expect(result).toStrictEqual(rawData);
          });
        });
      });
    });
  });
});
