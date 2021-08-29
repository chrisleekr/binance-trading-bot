/* eslint-disable no-lonely-if */
/* eslint-disable global-require */

describe('ensure-grid-trade-order-executed.js', () => {
  let result;
  let rawData;

  let binanceMock;
  let slackMock;
  let loggerMock;
  let PubSubMock;

  let mockCalculateLastBuyPrice;
  let mockGetAPILimit;
  let mockIsExceedAPILimit;
  let mockDisableAction;

  let mockSaveSymbolGridTrade;

  let mockGetGridTradeOrder;
  let mockDeleteGridTradeOrder;
  let mockSaveGridTradeOrder;

  const momentDateTime = '2020-01-02T00:00:00+00:00';

  describe('execute', () => {
    beforeEach(async () => {
      jest.clearAllMocks().resetModules();

      // Mock moment to return static date
      jest.mock(
        'moment',
        () => nextCheck =>
          jest.requireActual('moment')(nextCheck || '2020-01-02T00:00:00+00:00')
      );

      const { binance, slack, logger, PubSub } = require('../../../../helpers');

      binanceMock = binance;
      slackMock = slack;
      loggerMock = logger;
      PubSubMock = PubSub;

      PubSubMock.publish = jest.fn().mockResolvedValue(true);

      slackMock.sendMessage = jest.fn().mockResolvedValue(true);
      binanceMock.client.getOrder = jest.fn().mockResolvedValue([]);

      mockCalculateLastBuyPrice = jest.fn().mockResolvedValue(true);
      mockGetAPILimit = jest.fn().mockResolvedValue(10);
      mockIsExceedAPILimit = jest.fn().mockReturnValue(false);
      mockDisableAction = jest.fn().mockResolvedValue(true);

      mockSaveSymbolGridTrade = jest.fn().mockResolvedValue(true);

      mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);
      mockDeleteGridTradeOrder = jest.fn().mockResolvedValue(true);
      mockSaveGridTradeOrder = jest.fn().mockResolvedValue(true);
    });

    describe('when action is already determined', () => {
      beforeEach(async () => {
        jest.mock('../../../trailingTradeHelper/common', () => ({
          calculateLastBuyPrice: mockCalculateLastBuyPrice,
          getAPILimit: mockGetAPILimit,
          isExceedAPILimit: mockIsExceedAPILimit,
          disableAction: mockDisableAction
        }));

        jest.mock('../../../trailingTradeHelper/configuration', () => ({
          saveSymbolGridTrade: mockSaveSymbolGridTrade
        }));

        jest.mock('../../../trailingTradeHelper/order', () => ({
          getGridTradeOrder: mockGetGridTradeOrder,
          deleteGridTradeOrder: mockDeleteGridTradeOrder,
          saveGridTradeOrder: mockSaveGridTradeOrder
        }));

        const step = require('../ensure-grid-trade-order-executed');

        rawData = {
          symbol: 'BTCUSDT',
          action: 'buy',
          featureToggle: { notifyOrderExecute: true, notifyDebug: true },
          symbolConfiguration: {
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

      it('does not trigger getGridTradeOrder', () => {
        expect(mockGetGridTradeOrder).not.toHaveBeenCalled();
      });

      it('does not trigger saveGridTradeOrder', () => {
        expect(mockSaveGridTradeOrder).not.toHaveBeenCalled();
      });

      it('does not trigger deleteGridTradeOrder', () => {
        expect(mockDeleteGridTradeOrder).not.toHaveBeenCalled();
      });

      it('does not trigger binance.client.getOrder', () => {
        expect(binanceMock.client.getOrder).not.toHaveBeenCalled();
      });

      it('does not trigger disableAction', () => {
        expect(mockDisableAction).not.toHaveBeenCalled();
      });

      it('returns epxected result', () => {
        expect(result).toStrictEqual(rawData);
      });
    });

    describe('when api limit is exceed', () => {
      beforeEach(async () => {
        mockIsExceedAPILimit = jest.fn().mockReturnValue(true);

        jest.mock('../../../trailingTradeHelper/common', () => ({
          calculateLastBuyPrice: mockCalculateLastBuyPrice,
          getAPILimit: mockGetAPILimit,
          isExceedAPILimit: mockIsExceedAPILimit,
          disableAction: mockDisableAction
        }));

        jest.mock('../../../trailingTradeHelper/configuration', () => ({
          saveSymbolGridTrade: mockSaveSymbolGridTrade
        }));

        jest.mock('../../../trailingTradeHelper/order', () => ({
          getGridTradeOrder: mockGetGridTradeOrder,
          deleteGridTradeOrder: mockDeleteGridTradeOrder,
          saveGridTradeOrder: mockSaveGridTradeOrder
        }));

        const step = require('../ensure-grid-trade-order-executed');

        rawData = {
          symbol: 'BTCUSDT',
          action: 'not-determined',
          featureToggle: { notifyOrderExecute: true, notifyDebug: true },
          symbolConfiguration: {
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

      it('does not trigger getGridTradeOrder', () => {
        expect(mockGetGridTradeOrder).not.toHaveBeenCalled();
      });

      it('does not trigger saveGridTradeOrder', () => {
        expect(mockSaveGridTradeOrder).not.toHaveBeenCalled();
      });

      it('does not trigger deleteGridTradeOrder', () => {
        expect(mockDeleteGridTradeOrder).not.toHaveBeenCalled();
      });

      it('does not trigger binance.client.getOrder', () => {
        expect(binanceMock.client.getOrder).not.toHaveBeenCalled();
      });

      it('does not trigger disableAction', () => {
        expect(mockDisableAction).not.toHaveBeenCalled();
      });

      it('returns epxected result', () => {
        expect(result).toStrictEqual(rawData);
      });
    });

    describe('when found last buy order', () => {
      [
        {
          desc: 'last buy order is empty',
          symbol: 'BNBUSDT',
          lastBuyOrder: null,
          getOrder: null,
          saveSymbolGridTrade: null
        },
        {
          desc: 'last buy order is FILLED - currentGridTradeIndex: 0',
          symbol: 'BNBUSDT',
          notifyDebug: true,
          lastBuyOrder: {
            symbol: 'BNBUSDT',
            side: 'BUY',
            status: 'FILLED',
            type: 'STOP_LOSS_LIMIT',
            orderId: 2705449295,
            price: '302.09000000',
            origQty: '0.03320000',
            stopPrice: '301.80000000',
            currentGridTradeIndex: 0,
            nextCheck: '2020-01-01T23:59:00+00:00'
          },
          getOrder: null,
          saveSymbolGridTrade: {
            buy: [
              {
                executed: true,
                executedOrder: {
                  currentGridTradeIndex: 0,
                  nextCheck: '2020-01-01T23:59:00+00:00',
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
          lastBuyOrder: {
            symbol: 'BNBUSDT',
            side: 'BUY',
            status: 'FILLED',
            type: 'STOP_LOSS_LIMIT',
            orderId: 2705449295,
            price: '302.09000000',
            origQty: '0.03320000',
            stopPrice: '301.80000000',
            currentGridTradeIndex: 1,
            nextCheck: '2020-01-01T23:59:00+00:00'
          },
          getOrder: null,
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
                  nextCheck: '2020-01-01T23:59:00+00:00',
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
          desc: 'last buy order is NEW and still NEW before checking the order',
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
            currentGridTradeIndex: 0,
            nextCheck: '2020-01-02T00:01:00+00:00'
          },
          getOrder: null,
          saveSymbolGridTrade: null
        },
        {
          desc: 'last buy order is NEW and still NEW after checking the order',
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
            currentGridTradeIndex: 0,
            nextCheck: '2020-01-01T23:59:00+00:00'
          },
          getOrder: {
            symbol: 'BNBUSDT',
            side: 'BUY',
            status: 'NEW',
            type: 'STOP_LOSS_LIMIT',
            orderId: 2705449295,
            price: '302.09000000',
            origQty: '0.03320000',
            stopPrice: '301.80000000'
          },
          saveSymbolGridTrade: null
        },
        ...['CANCELED', 'REJECTED', 'EXPIRED', 'PENDING_CANCEL'].map(
          status => ({
            desc: `last buy order is NEW and become ${status}`,
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
              currentGridTradeIndex: 0,
              nextCheck: '2020-01-01T23:59:00+00:00'
            },
            getOrder: {
              symbol: 'BNBUSDT',
              side: 'BUY',
              status,
              type: 'STOP_LOSS_LIMIT',
              orderId: 2705449295,
              price: '302.09000000',
              origQty: '0.03320000',
              stopPrice: '301.80000000'
            },
            saveSymbolGridTrade: null
          })
        ),
        {
          desc: 'last buy order is NEW and now FILLED',
          symbol: 'BNBUSDT',
          notifyDebug: false,
          lastBuyOrder: {
            symbol: 'BNBUSDT',
            side: 'BUY',
            status: 'NEW',
            type: 'STOP_LOSS_LIMIT',
            orderId: 2705449295,
            price: '302.09000000',
            origQty: '0.03320000',
            stopPrice: '301.80000000',
            currentGridTradeIndex: 0,
            nextCheck: '2020-01-01T23:59:00+00:00'
          },
          getOrder: {
            symbol: 'BNBUSDT',
            side: 'BUY',
            status: 'FILLED',
            type: 'STOP_LOSS_LIMIT',
            orderId: 2705449295,
            price: '302.09000000',
            origQty: '0.03320000',
            stopPrice: '301.80000000'
          },
          saveSymbolGridTrade: {
            buy: [
              {
                executed: true,
                executedOrder: {
                  currentGridTradeIndex: 0,
                  nextCheck: '2020-01-01T23:59:00+00:00',
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
          desc: 'last buy order is NEW and now FILLED - currentGridTradeIndex: 1',
          symbol: 'BNBUSDT',
          notifyDebug: true,
          lastBuyOrder: {
            symbol: 'BNBUSDT',
            side: 'BUY',
            status: 'NEW',
            type: 'STOP_LOSS_LIMIT',
            orderId: 2705449295,
            price: '302.09000000',
            origQty: '0.03320000',
            stopPrice: '301.80000000',
            currentGridTradeIndex: 1,
            nextCheck: '2020-01-01T23:59:00+00:00'
          },
          getOrder: {
            symbol: 'BNBUSDT',
            side: 'BUY',
            status: 'FILLED',
            type: 'STOP_LOSS_LIMIT',
            orderId: 2705449295,
            price: '302.09000000',
            origQty: '0.03320000',
            stopPrice: '301.80000000'
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
                  nextCheck: '2020-01-01T23:59:00+00:00',
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
          desc: 'last buy order is NEW but error',
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
            currentGridTradeIndex: 0,
            nextCheck: '2020-01-01T23:59:00+00:00'
          },
          getOrder: 'error',
          saveSymbolGridTrade: null
        }
      ].forEach((t, index) => {
        describe(`${t.desc}`, () => {
          beforeEach(async () => {
            if (t.getOrder === 'error') {
              binanceMock.client.getOrder = jest
                .fn()
                .mockRejectedValue(new Error('something happened'));
            } else {
              binanceMock.client.getOrder = jest
                .fn()
                .mockResolvedValue(t.getOrder);
            }

            jest.mock('../../../trailingTradeHelper/common', () => ({
              calculateLastBuyPrice: mockCalculateLastBuyPrice,
              getAPILimit: mockGetAPILimit,
              isExceedAPILimit: mockIsExceedAPILimit,
              disableAction: mockDisableAction
            }));

            jest.mock('../../../trailingTradeHelper/configuration', () => ({
              saveSymbolGridTrade: mockSaveSymbolGridTrade
            }));

            mockGetGridTradeOrder = jest
              .fn()
              .mockImplementation((_logger, key) => {
                if (key === `${t.symbol}-grid-trade-last-buy-order`) {
                  return t.lastBuyOrder;
                }

                return null;
              });

            jest.mock('../../../trailingTradeHelper/order', () => ({
              getGridTradeOrder: mockGetGridTradeOrder,
              deleteGridTradeOrder: mockDeleteGridTradeOrder,
              saveGridTradeOrder: mockSaveGridTradeOrder
            }));

            const step = require('../ensure-grid-trade-order-executed');

            rawData = {
              symbol: t.symbol,
              action: 'not-determined',
              featureToggle: {
                notifyOrderExecute: index % 2,
                notifyDebug: t.notifyDebug || false
              },
              symbolConfiguration: {
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

          it('triggers getGridTradeOrder for getting cached order', () => {
            expect(mockGetGridTradeOrder).toHaveBeenCalledWith(
              loggerMock,
              `${t.symbol}-grid-trade-last-buy-order`
            );
          });

          if (t.lastBuyOrder === null) {
            // If last order is not found
            it('does not trigger binance.client.getOrder as order not found', () => {
              expect(binanceMock.client.getOrder).not.toHaveBeenCalled();
            });

            it('does not trigger saveGridTradeOrder as order not found', () => {
              expect(mockSaveGridTradeOrder).not.toHaveBeenCalled();
            });

            it('does not trigger deleteGridTradeOrder as order not found', () => {
              expect(mockDeleteGridTradeOrder).not.toHaveBeenCalled();
            });

            it('does not trigger saveSymbolGridTrade', () => {
              expect(mockSaveSymbolGridTrade).not.toHaveBeenCalled();
            });

            it('does not trigger disableAction', () => {
              expect(mockDisableAction).not.toHaveBeenCalled();
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
          } else {
            if (t.getOrder === 'error') {
              // order throws an error
              it('triggers saveGridTradeOrder for last buy order as order throws error', () => {
                expect(mockSaveGridTradeOrder).toHaveBeenCalledWith(
                  loggerMock,
                  `${t.symbol}-grid-trade-last-buy-order`,
                  {
                    ...t.lastBuyOrder,
                    // 10 secs
                    nextCheck: '2020-01-02T00:00:10+00:00'
                  }
                );
              });

              it('does not trigger saveSymbolGridTrade as order throws error', () => {
                expect(mockSaveSymbolGridTrade).not.toHaveBeenCalled();
              });

              it('does not trigger deleteGridTradeOrder for last buy order as order throws error', () => {
                expect(mockDeleteGridTradeOrder).not.toHaveBeenCalled();
              });

              it('does not trigger disableAction as order throws error', () => {
                expect(mockDisableAction).not.toHaveBeenCalled();
              });
            } else if (
              Date.parse(t.lastBuyOrder.nextCheck) < Date.parse(momentDateTime)
            ) {
              // time to check order
              it('triggers binance.client.getOrder as time to check', () => {
                expect(binanceMock.client.getOrder).toHaveBeenCalledWith({
                  symbol: t.symbol,
                  orderId: t.lastBuyOrder.orderId
                });
              });

              if (t.getOrder.status === 'FILLED') {
                // do filled thing
                it('triggers calculated last buy price as order filled after getting order result', () => {
                  expect(mockCalculateLastBuyPrice).toHaveBeenCalledWith(
                    loggerMock,
                    t.symbol,
                    t.getOrder
                  );
                });

                it('triggers save symbol grid trade as order filled after getting order result', () => {
                  expect(mockSaveSymbolGridTrade).toHaveBeenCalledWith(
                    loggerMock,
                    t.symbol,
                    t.saveSymbolGridTrade
                  );
                });

                it('triggers deleteGridTradeOrder as order filled after getting order result', () => {
                  expect(mockDeleteGridTradeOrder).toHaveBeenCalledWith(
                    loggerMock,
                    `${t.symbol}-grid-trade-last-buy-order`
                  );
                });

                it('triggers disableAction after getting order result', () => {
                  expect(mockDisableAction).toHaveBeenCalledWith(
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
              } else if (
                ['CANCELED', 'REJECTED', 'EXPIRED', 'PENDING_CANCEL'].includes(
                  t.getOrder.status
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
              } else {
                // do else thing
                it('triggers saveGridTradeOrder for last buy order as not filled', () => {
                  expect(mockSaveGridTradeOrder).toHaveBeenCalledWith(
                    loggerMock,
                    `${t.symbol}-grid-trade-last-buy-order`,
                    {
                      ...t.getOrder,
                      currentGridTradeIndex:
                        t.lastBuyOrder.currentGridTradeIndex,
                      // 10 secs
                      nextCheck: '2020-01-02T00:00:10+00:00'
                    }
                  );
                });

                it('does not trigger deleteGridTradeOrder for last buy order as not filled', () => {
                  expect(mockDeleteGridTradeOrder).not.toHaveBeenCalled();
                });

                it('does not trigger saveSymbolGridTrade as not filled', () => {
                  expect(mockSaveSymbolGridTrade).not.toHaveBeenCalled();
                });

                it('does not trigger disableAction as not filled', () => {
                  expect(mockDisableAction).not.toHaveBeenCalled();
                });
              }
            } else if (
              Date.parse(t.lastBuyOrder.nextCheck) > Date.parse(momentDateTime)
            ) {
              // no need to check
              it('does not trigger binance.client.getOrder because time is not yet to check', () => {
                expect(binanceMock.client.getOrder).not.toHaveBeenCalled();
              });

              it('does not trigger saveGridTradeOrder because time is not yet to check', () => {
                expect(mockSaveGridTradeOrder).not.toHaveBeenCalled();
              });

              it('does not trigger deleteGridTradeOrder because time is not yet to check', () => {
                expect(mockDeleteGridTradeOrder).not.toHaveBeenCalled();
              });

              it('does not trigger saveSymbolGridTrade because time is not yet to check', () => {
                expect(mockSaveSymbolGridTrade).not.toHaveBeenCalled();
              });

              it('does not trigger disableAction because time is not yet to check', () => {
                expect(mockDisableAction).not.toHaveBeenCalled();
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
            currentGridTradeIndex: 0,
            nextCheck: '2020-01-01T23:59:00+00:00'
          },
          getOrder: null,
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
                  nextCheck: '2020-01-01T23:59:00+00:00',
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
            currentGridTradeIndex: 1,
            nextCheck: '2020-01-01T23:59:00+00:00'
          },
          getOrder: null,
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
                  nextCheck: '2020-01-01T23:59:00+00:00',
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
          desc: 'last sell order is NEW and still NEW before checking the order',
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
            currentGridTradeIndex: 0,
            nextCheck: '2020-01-02T00:01:00+00:00'
          },
          getOrder: null,
          saveSymbolGridTrade: null
        },
        {
          desc: 'last sell order is NEW and still NEW after checking the order',
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
            currentGridTradeIndex: 0,
            nextCheck: '2020-01-01T23:59:00+00:00'
          },
          getOrder: {
            symbol: 'BNBUSDT',
            side: 'SELL',
            status: 'NEW',
            type: 'STOP_LOSS_LIMIT',
            orderId: 2705449295,
            price: '302.09000000',
            origQty: '0.03320000',
            stopPrice: '301.80000000'
          },
          saveSymbolGridTrade: null
        },
        ...['CANCELED', 'REJECTED', 'EXPIRED', 'PENDING_CANCEL'].map(
          status => ({
            desc: `last sell order is NEW and become ${status}`,
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
              currentGridTradeIndex: 0,
              nextCheck: '2020-01-01T23:59:00+00:00'
            },
            getOrder: {
              symbol: 'BNBUSDT',
              side: 'SELL',
              status,
              type: 'STOP_LOSS_LIMIT',
              orderId: 2705449295,
              price: '302.09000000',
              origQty: '0.03320000',
              stopPrice: '301.80000000'
            },
            saveSymbolGridTrade: null
          })
        ),
        {
          desc: 'last sell order is NEW and now FILLED - currentGridTradeIndex: 0',
          symbol: 'BNBUSDT',
          notifyDebug: true,
          lastSellOrder: {
            symbol: 'BNBUSDT',
            side: 'SELL',
            status: 'NEW',
            type: 'STOP_LOSS_LIMIT',
            orderId: 2705449295,
            price: '302.09000000',
            origQty: '0.03320000',
            stopPrice: '301.80000000',
            currentGridTradeIndex: 0,
            nextCheck: '2020-01-01T23:59:00+00:00'
          },
          getOrder: {
            symbol: 'BNBUSDT',
            side: 'SELL',
            status: 'FILLED',
            type: 'STOP_LOSS_LIMIT',
            orderId: 2705449295,
            price: '302.09000000',
            origQty: '0.03320000',
            stopPrice: '301.80000000'
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
                  nextCheck: '2020-01-01T23:59:00+00:00',
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
          desc: 'last sell order is NEW and now FILLED - currentGridTradeIndex: 1',
          symbol: 'BNBUSDT',
          notifyDebug: false,
          lastSellOrder: {
            symbol: 'BNBUSDT',
            side: 'SELL',
            status: 'NEW',
            type: 'STOP_LOSS_LIMIT',
            orderId: 2705449295,
            price: '302.09000000',
            origQty: '0.03320000',
            stopPrice: '301.80000000',
            currentGridTradeIndex: 1,
            nextCheck: '2020-01-01T23:59:00+00:00'
          },
          getOrder: {
            symbol: 'BNBUSDT',
            side: 'SELL',
            status: 'FILLED',
            type: 'STOP_LOSS_LIMIT',
            orderId: 2705449295,
            price: '302.09000000',
            origQty: '0.03320000',
            stopPrice: '301.80000000'
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
                  nextCheck: '2020-01-01T23:59:00+00:00',
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
          desc: 'last sell order is NEW but error',
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
            currentGridTradeIndex: 0,
            nextCheck: '2020-01-01T23:59:00+00:00'
          },
          getOrder: 'error',
          saveSymbolGridTrade: {}
        }
      ].forEach((t, index) => {
        describe(`${t.desc}`, () => {
          beforeEach(async () => {
            if (t.getOrder === 'error') {
              binanceMock.client.getOrder = jest
                .fn()
                .mockRejectedValue(new Error('something happened'));
            } else {
              binanceMock.client.getOrder = jest
                .fn()
                .mockResolvedValue(t.getOrder);
            }
            jest.mock('../../../trailingTradeHelper/common', () => ({
              calculateLastBuyPrice: mockCalculateLastBuyPrice,
              getAPILimit: mockGetAPILimit,
              isExceedAPILimit: mockIsExceedAPILimit,
              disableAction: mockDisableAction
            }));

            jest.mock('../../../trailingTradeHelper/configuration', () => ({
              saveSymbolGridTrade: mockSaveSymbolGridTrade
            }));

            mockGetGridTradeOrder = jest
              .fn()
              .mockImplementation((_logger, key) => {
                if (key === `${t.symbol}-grid-trade-last-sell-order`) {
                  return t.lastSellOrder;
                }

                return null;
              });

            jest.mock('../../../trailingTradeHelper/order', () => ({
              getGridTradeOrder: mockGetGridTradeOrder,
              deleteGridTradeOrder: mockDeleteGridTradeOrder,
              saveGridTradeOrder: mockSaveGridTradeOrder
            }));

            const step = require('../ensure-grid-trade-order-executed');

            rawData = {
              symbol: t.symbol,
              action: 'not-determined',
              featureToggle: {
                notifyOrderExecute: index % 2,
                notifyDebug: index % 2
              },
              symbolConfiguration: {
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

          it('triggers getGridTradeOrder for getting cached order', () => {
            expect(mockGetGridTradeOrder).toHaveBeenCalledWith(
              loggerMock,
              `${t.symbol}-grid-trade-last-sell-order`
            );
          });

          if (t.lastSellOrder === null) {
            // If last order is not found
            it('does not trigger binance.client.getOrder as order not found', () => {
              expect(binanceMock.client.getOrder).not.toHaveBeenCalled();
            });

            it('does not trigger saveGridTradeOrder as order not found', () => {
              expect(mockSaveGridTradeOrder).not.toHaveBeenCalled();
            });

            it('does not trigger deleteGridTradeOrder as order not found', () => {
              expect(mockDeleteGridTradeOrder).not.toHaveBeenCalled();
            });

            it('does not trigger disableAction', () => {
              expect(mockDisableAction).not.toHaveBeenCalled();
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

            it('triggers disableAction as order filled', () => {
              expect(mockDisableAction).toHaveBeenCalledWith(
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
          } else {
            if (t.getOrder === 'error') {
              // order throws an error
              it('triggers saveGridTradeOrder for last sell order as order throws error', () => {
                expect(mockSaveGridTradeOrder).toHaveBeenCalledWith(
                  loggerMock,
                  `${t.symbol}-grid-trade-last-sell-order`,
                  {
                    ...t.lastSellOrder,
                    // 10 secs
                    nextCheck: '2020-01-02T00:00:10+00:00'
                  }
                );
              });

              it('does not trigger saveSymbolGridTrade as order throws error', () => {
                expect(mockSaveSymbolGridTrade).not.toHaveBeenCalled();
              });

              it('does not trigger deleteGridTradeOrder for last sell order as order throws error', () => {
                expect(mockDeleteGridTradeOrder).not.toHaveBeenCalled();
              });

              it('does not trigger disableAction as order throws error', () => {
                expect(mockDisableAction).not.toHaveBeenCalled();
              });
            } else if (
              Date.parse(t.lastSellOrder.nextCheck) < Date.parse(momentDateTime)
            ) {
              // time to check order
              it('triggers binance.client.getOrder as time to check', () => {
                expect(binanceMock.client.getOrder).toHaveBeenCalledWith({
                  symbol: t.symbol,
                  orderId: t.lastSellOrder.orderId
                });
              });

              if (t.getOrder.status === 'FILLED') {
                // do filled thing
                it('triggers save symbol grid trade as order filled after getting order result', () => {
                  expect(mockSaveSymbolGridTrade).toHaveBeenCalledWith(
                    loggerMock,
                    t.symbol,
                    t.saveSymbolGridTrade
                  );
                });

                it('triggers deleteGridTradeOrder as order filled after getting order result', () => {
                  expect(mockDeleteGridTradeOrder).toHaveBeenCalledWith(
                    loggerMock,
                    `${t.symbol}-grid-trade-last-sell-order`
                  );
                });

                it('triggers disableAction after getting order result', () => {
                  expect(mockDisableAction).toHaveBeenCalledWith(
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
              } else if (
                ['CANCELED', 'REJECTED', 'EXPIRED', 'PENDING_CANCEL'].includes(
                  t.getOrder.status
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
              } else {
                // do else thing
                it('triggers saveGridTradeOrder for last sell order as not filled', () => {
                  expect(mockSaveGridTradeOrder).toHaveBeenCalledWith(
                    loggerMock,
                    `${t.symbol}-grid-trade-last-sell-order`,
                    {
                      ...t.getOrder,
                      currentGridTradeIndex:
                        t.lastSellOrder.currentGridTradeIndex,
                      // 10 secs
                      nextCheck: '2020-01-02T00:00:10+00:00'
                    }
                  );
                });

                it('does not trigger deleteGridTradeOrder for last sell order as not filled', () => {
                  expect(mockDeleteGridTradeOrder).not.toHaveBeenCalled();
                });

                it('does not trigger saveSymbolGridTrade as not filled', () => {
                  expect(mockSaveSymbolGridTrade).not.toHaveBeenCalled();
                });

                it('does not trigger disableAction as not filled', () => {
                  expect(mockDisableAction).not.toHaveBeenCalled();
                });
              }
            } else if (
              Date.parse(t.lastSellOrder.nextCheck) > Date.parse(momentDateTime)
            ) {
              // no need to check
              it('does not trigger binance.client.getOrder because time is not yet to check', () => {
                expect(binanceMock.client.getOrder).not.toHaveBeenCalled();
              });

              it('does not trigger saveGridTradeOrder because time is not yet to check', () => {
                expect(mockSaveGridTradeOrder).not.toHaveBeenCalled();
              });

              it('does not trigger deleteGridTradeOrder because time is not yet to check', () => {
                expect(mockDeleteGridTradeOrder).not.toHaveBeenCalled();
              });

              it('does not trigger saveSymbolGridTrade because time is not yet to check', () => {
                expect(mockSaveSymbolGridTrade).not.toHaveBeenCalled();
              });

              it('does not trigger disableAction because time is not yet to check', () => {
                expect(mockDisableAction).not.toHaveBeenCalled();
              });
            }
          }

          it('returns result', () => {
            expect(result).toStrictEqual(rawData);
          });
        });
      });
    });

    describe('slackMessageOrderFilled', () => {
      describe('when orderParams does not have type for some reason', () => {
        beforeEach(async () => {
          binanceMock.client.getOrder = jest.fn().mockResolvedValue({
            symbol: 'BNBUSDT',
            side: 'BUY',
            status: 'FILLED',
            type: 'STOP_LOSS_LIMIT'
          });

          jest.mock('../../../trailingTradeHelper/common', () => ({
            calculateLastBuyPrice: mockCalculateLastBuyPrice,
            getAPILimit: mockGetAPILimit,
            isExceedAPILimit: mockIsExceedAPILimit,
            disableAction: mockDisableAction
          }));

          jest.mock('../../../trailingTradeHelper/configuration', () => ({
            saveSymbolGridTrade: mockSaveSymbolGridTrade
          }));

          mockGetGridTradeOrder = jest
            .fn()
            .mockImplementation((_logger, key) => {
              if (key === `BTCUSDT-grid-trade-last-buy-order`) {
                return {
                  symbol: 'BTCUSDT',
                  side: 'BUY',
                  status: 'NEW',
                  currentGridTradeIndex: 0,
                  nextCheck: '2020-01-01T23:59:00+00:00'
                };
              }
              return null;
            });

          jest.mock('../../../trailingTradeHelper/order', () => ({
            getGridTradeOrder: mockGetGridTradeOrder,
            deleteGridTradeOrder: mockDeleteGridTradeOrder,
            saveGridTradeOrder: mockSaveGridTradeOrder
          }));

          const step = require('../ensure-grid-trade-order-executed');

          rawData = {
            symbol: 'BTCUSDT',
            action: 'not-determined',
            featureToggle: {
              notifyOrderExecute: true,
              notifyDebug: false
            },
            symbolConfiguration: {
              buy: {
                gridTrade: [
                  {
                    triggerPercentage: 1,
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

        it('triggers slack.sendMessage', () => {
          expect(slackMock.sendMessage).toHaveBeenCalledWith(
            expect.stringContaining('STOP_LOSS_LIMIT')
          );
        });
      });

      describe('when orderParams/orderResult is empty for some reason', () => {
        beforeEach(async () => {
          binanceMock.client.getOrder = jest.fn().mockResolvedValue({
            symbol: 'BNBUSDT',
            side: 'BUY',
            status: 'FILLED'
          });

          jest.mock('../../../trailingTradeHelper/common', () => ({
            calculateLastBuyPrice: mockCalculateLastBuyPrice,
            getAPILimit: mockGetAPILimit,
            isExceedAPILimit: mockIsExceedAPILimit,
            disableAction: mockDisableAction
          }));

          jest.mock('../../../trailingTradeHelper/configuration', () => ({
            saveSymbolGridTrade: mockSaveSymbolGridTrade
          }));

          mockGetGridTradeOrder = jest
            .fn()
            .mockImplementation((_logger, key) => {
              if (key === `BTCUSDT-grid-trade-last-buy-order`) {
                return {
                  symbol: 'BTCUSDT',
                  side: 'BUY',
                  status: 'NEW',
                  currentGridTradeIndex: 0,
                  nextCheck: '2020-01-01T23:59:00+00:00'
                };
              }
              return null;
            });

          jest.mock('../../../trailingTradeHelper/order', () => ({
            getGridTradeOrder: mockGetGridTradeOrder,
            deleteGridTradeOrder: mockDeleteGridTradeOrder,
            saveGridTradeOrder: mockSaveGridTradeOrder
          }));

          const step = require('../ensure-grid-trade-order-executed');

          rawData = {
            symbol: 'BTCUSDT',
            action: 'not-determined',
            featureToggle: {
              notifyOrderExecute: true,
              notifyDebug: false
            },
            symbolConfiguration: {
              buy: {
                gridTrade: [
                  {
                    triggerPercentage: 1,
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

        it('triggers slack.sendMessage', () => {
          expect(slackMock.sendMessage).toHaveBeenCalledWith(
            expect.stringContaining('Undefined')
          );
        });
      });
    });

    describe('slackMessageOrderDeleted', () => {
      describe('when orderParams does not have type for some reason', () => {
        beforeEach(async () => {
          binanceMock.client.getOrder = jest.fn().mockResolvedValue({
            symbol: 'BNBUSDT',
            side: 'BUY',
            status: 'CANCELED',
            type: 'STOP_LOSS_LIMIT'
          });

          jest.mock('../../../trailingTradeHelper/common', () => ({
            calculateLastBuyPrice: mockCalculateLastBuyPrice,
            getAPILimit: mockGetAPILimit,
            isExceedAPILimit: mockIsExceedAPILimit,
            disableAction: mockDisableAction
          }));

          jest.mock('../../../trailingTradeHelper/configuration', () => ({
            saveSymbolGridTrade: mockSaveSymbolGridTrade
          }));

          mockGetGridTradeOrder = jest
            .fn()
            .mockImplementation((_logger, key) => {
              if (key === `BTCUSDT-grid-trade-last-buy-order`) {
                return {
                  symbol: 'BTCUSDT',
                  side: 'BUY',
                  status: 'NEW',
                  currentGridTradeIndex: 0,
                  nextCheck: '2020-01-01T23:59:00+00:00'
                };
              }
              return null;
            });

          jest.mock('../../../trailingTradeHelper/order', () => ({
            getGridTradeOrder: mockGetGridTradeOrder,
            deleteGridTradeOrder: mockDeleteGridTradeOrder,
            saveGridTradeOrder: mockSaveGridTradeOrder
          }));

          const step = require('../ensure-grid-trade-order-executed');

          rawData = {
            symbol: 'BTCUSDT',
            action: 'not-determined',
            featureToggle: {
              notifyOrderExecute: true,
              notifyDebug: false
            },
            symbolConfiguration: {
              buy: {
                gridTrade: [
                  {
                    triggerPercentage: 1,
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

        it('triggers slack.sendMessage', () => {
          expect(slackMock.sendMessage).toHaveBeenCalledWith(
            expect.stringContaining('STOP_LOSS_LIMIT')
          );
        });
      });

      describe('when orderParams/orderResult is empty for some reason', () => {
        beforeEach(async () => {
          binanceMock.client.getOrder = jest.fn().mockResolvedValue({
            symbol: 'BNBUSDT',
            side: 'BUY',
            status: 'CANCELED'
          });

          jest.mock('../../../trailingTradeHelper/common', () => ({
            calculateLastBuyPrice: mockCalculateLastBuyPrice,
            getAPILimit: mockGetAPILimit,
            isExceedAPILimit: mockIsExceedAPILimit,
            disableAction: mockDisableAction
          }));

          jest.mock('../../../trailingTradeHelper/configuration', () => ({
            saveSymbolGridTrade: mockSaveSymbolGridTrade
          }));

          mockGetGridTradeOrder = jest
            .fn()
            .mockImplementation((_logger, key) => {
              if (key === `BTCUSDT-grid-trade-last-buy-order`) {
                return {
                  symbol: 'BTCUSDT',
                  side: 'BUY',
                  status: 'NEW',
                  currentGridTradeIndex: 0,
                  nextCheck: '2020-01-01T23:59:00+00:00'
                };
              }
              return null;
            });

          jest.mock('../../../trailingTradeHelper/order', () => ({
            getGridTradeOrder: mockGetGridTradeOrder,
            deleteGridTradeOrder: mockDeleteGridTradeOrder,
            saveGridTradeOrder: mockSaveGridTradeOrder
          }));

          const step = require('../ensure-grid-trade-order-executed');

          rawData = {
            symbol: 'BTCUSDT',
            action: 'not-determined',
            featureToggle: {
              notifyOrderExecute: true,
              notifyDebug: false
            },
            symbolConfiguration: {
              buy: {
                gridTrade: [
                  {
                    triggerPercentage: 1,
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

        it('triggers slack.sendMessage', () => {
          expect(slackMock.sendMessage).toHaveBeenCalledWith(
            expect.stringContaining('Undefined')
          );
        });
      });
    });
  });
});
