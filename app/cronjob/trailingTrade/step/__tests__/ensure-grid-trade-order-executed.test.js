/* eslint-disable no-lonely-if */
/* eslint-disable global-require */

const _ = require('lodash');

describe('ensure-grid-trade-order-executed.js', () => {
  let result;
  let rawData;

  let binanceMock;
  let slackMock;
  let loggerMock;
  let cacheMock;
  let PubSubMock;

  let mockCalculateLastBuyPrice;
  let mockGetAPILimit;
  let mockIsExceedAPILimit;
  let mockDisableAction;
  let mockSaveOrder;

  let mockSaveSymbolGridTrade;

  const momentDateTime = '2020-01-02T00:00:00.000Z';

  describe('execute', () => {
    beforeEach(async () => {
      jest.clearAllMocks().resetModules();

      // Mock moment to return static date
      jest.mock(
        'moment',
        () => nextCheck =>
          jest.requireActual('moment')(nextCheck || '2020-01-02T00:00:00.000Z')
      );

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

      cacheMock.get = jest.fn().mockResolvedValue(null);
      cacheMock.set = jest.fn().mockResolvedValue(true);
      cacheMock.del = jest.fn().mockResolvedValue(true);

      PubSubMock.publish = jest.fn().mockResolvedValue(true);

      slackMock.sendMessage = jest.fn().mockResolvedValue(true);
      binanceMock.client.getOrder = jest.fn().mockResolvedValue([]);

      mockCalculateLastBuyPrice = jest.fn().mockResolvedValue(true);
      mockGetAPILimit = jest.fn().mockResolvedValue(10);
      mockIsExceedAPILimit = jest.fn().mockReturnValue(false);
      mockDisableAction = jest.fn().mockResolvedValue(true);
      mockSaveOrder = jest.fn().mockResolvedValue(true);

      mockSaveSymbolGridTrade = jest.fn().mockResolvedValue(true);
    });

    describe('when action is already determined', () => {
      beforeEach(async () => {
        jest.mock('../../../trailingTradeHelper/common', () => ({
          calculateLastBuyPrice: mockCalculateLastBuyPrice,
          getAPILimit: mockGetAPILimit,
          isExceedAPILimit: mockIsExceedAPILimit,
          disableAction: mockDisableAction,
          saveOrder: mockSaveOrder
        }));

        jest.mock('../../../trailingTradeHelper/configuration', () => ({
          saveSymbolGridTrade: mockSaveSymbolGridTrade
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

      it('does not trigger cache.get', () => {
        expect(cacheMock.get).not.toHaveBeenCalled();
      });

      it('does not trigger cache.set', () => {
        expect(cacheMock.set).not.toHaveBeenCalled();
      });

      it('does not trigger cache.del', () => {
        expect(cacheMock.del).not.toHaveBeenCalled();
      });

      it('does not trigger binance.client.getOrder', () => {
        expect(binanceMock.client.getOrder).not.toHaveBeenCalled();
      });

      it('does not trigger disableAction', () => {
        expect(mockDisableAction).not.toHaveBeenCalled();
      });

      it('does not trigger saveOrder', () => {
        expect(mockSaveOrder).not.toHaveBeenCalled();
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
          disableAction: mockDisableAction,
          saveOrder: mockSaveOrder
        }));

        jest.mock('../../../trailingTradeHelper/configuration', () => ({
          saveSymbolGridTrade: mockSaveSymbolGridTrade
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

      it('does not trigger cache.get', () => {
        expect(cacheMock.get).not.toHaveBeenCalled();
      });

      it('does not trigger cache.set', () => {
        expect(cacheMock.set).not.toHaveBeenCalled();
      });

      it('does not trigger cache.del', () => {
        expect(cacheMock.del).not.toHaveBeenCalled();
      });

      it('does not trigger binance.client.getOrder', () => {
        expect(binanceMock.client.getOrder).not.toHaveBeenCalled();
      });

      it('does not trigger disableAction', () => {
        expect(mockDisableAction).not.toHaveBeenCalled();
      });

      it('does not trigger saveOrder', () => {
        expect(mockSaveOrder).not.toHaveBeenCalled();
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
            nextCheck: '2020-01-01T23:59:00.000Z'
          },
          getOrder: null,
          saveSymbolGridTrade: {
            buy: [
              {
                executed: true,
                executedOrder: {
                  currentGridTradeIndex: 0,
                  nextCheck: '2020-01-01T23:59:00.000Z',
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
            nextCheck: '2020-01-01T23:59:00.000Z'
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
                  nextCheck: '2020-01-01T23:59:00.000Z',
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
            nextCheck: '2020-01-02T00:01:00.000Z'
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
            nextCheck: '2020-01-01T23:59:00.000Z'
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
              nextCheck: '2020-01-01T23:59:00.000Z'
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
            nextCheck: '2020-01-01T23:59:00.000Z'
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
                  nextCheck: '2020-01-01T23:59:00.000Z',
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
            nextCheck: '2020-01-01T23:59:00.000Z'
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
                  nextCheck: '2020-01-01T23:59:00.000Z',
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
            nextCheck: '2020-01-01T23:59:00.000Z'
          },
          getOrder: 'error',
          saveSymbolGridTrade: null
        }
      ].forEach((t, index) => {
        describe(`${t.desc}`, () => {
          beforeEach(async () => {
            cacheMock.get = jest.fn().mockImplementation(key => {
              if (key === `${t.symbol}-grid-trade-last-buy-order`) {
                return JSON.stringify(t.lastBuyOrder);
              }

              return null;
            });

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
              disableAction: mockDisableAction,
              saveOrder: mockSaveOrder
            }));

            jest.mock('../../../trailingTradeHelper/configuration', () => ({
              saveSymbolGridTrade: mockSaveSymbolGridTrade
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

          it('triggers cache.get for getting cached order', () => {
            expect(cacheMock.get).toHaveBeenCalledWith(
              `${t.symbol}-grid-trade-last-buy-order`
            );
          });

          if (t.lastBuyOrder === null) {
            // If last order is not found
            it('does not trigger binance.client.getOrder as order not found', () => {
              expect(binanceMock.client.getOrder).not.toHaveBeenCalled();
            });

            it('does not trigger cache.set as order not found', () => {
              expect(cacheMock.set).not.toHaveBeenCalled();
            });

            it('does not trigger cache.del as order not found', () => {
              expect(cacheMock.del).not.toHaveBeenCalled();
            });

            it('does not trigger saveSymbolGridTrade', () => {
              expect(mockSaveSymbolGridTrade).not.toHaveBeenCalled();
            });

            it('does not trigger disableAction', () => {
              expect(mockDisableAction).not.toHaveBeenCalled();
            });

            it('does not trigger saveOrder', () => {
              expect(mockSaveOrder).not.toHaveBeenCalled();
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

            it('triggers cache.del as order filled', () => {
              expect(cacheMock.del).toHaveBeenCalledWith(
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

            it('triggers saveOrder as order filled', () => {
              const { lastBuyOrder } = t;

              const order = _.cloneDeep(lastBuyOrder);

              expect(mockSaveOrder).toHaveBeenCalledWith(loggerMock, {
                order,
                botStatus: {
                  savedAt: expect.any(String),
                  savedBy: 'ensure-grid-trade-order-executed',
                  savedMessage:
                    'The order has already filled and updated the last buy price.'
                }
              });
            });
          } else {
            if (t.getOrder === 'error') {
              // order throws an error
              it('triggers cache.set for last buy order as order throws error', () => {
                expect(cacheMock.set).toHaveBeenCalledWith(
                  `${t.symbol}-grid-trade-last-buy-order`,
                  JSON.stringify({
                    ...t.lastBuyOrder,
                    // 10 secs
                    nextCheck: '2020-01-02T00:00:10.000Z'
                  })
                );
              });

              it('does not trigger saveSymbolGridTrade as order throws error', () => {
                expect(mockSaveSymbolGridTrade).not.toHaveBeenCalled();
              });

              it('does not trigger cache.del for last buy order as order throws error', () => {
                expect(cacheMock.del).not.toHaveBeenCalled();
              });

              it('does not trigger disableAction as order throws error', () => {
                expect(mockDisableAction).not.toHaveBeenCalled();
              });

              it('triggers saveOrder as order throws error', () => {
                const { lastBuyOrder } = t;

                const order = _.cloneDeep(lastBuyOrder);

                expect(mockSaveOrder).toHaveBeenCalledWith(loggerMock, {
                  order,
                  botStatus: {
                    savedAt: expect.any(String),
                    savedBy: 'ensure-grid-trade-order-executed',
                    savedMessage:
                      'The order could not be found or error occurred querying the order.'
                  }
                });
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

                it('triggers cache.del as order filled after getting order result', () => {
                  expect(cacheMock.del).toHaveBeenCalledWith(
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

                it('triggers saveOrder as order filled after getting order result', () => {
                  expect(mockSaveOrder).toHaveBeenCalledWith(loggerMock, {
                    order: {
                      ...t.lastBuyOrder,
                      ...t.getOrder
                    },
                    botStatus: {
                      savedAt: expect.any(String),
                      savedBy: 'ensure-grid-trade-order-executed',
                      savedMessage:
                        'The order has filled and updated the last buy price.'
                    }
                  });
                });
              } else if (
                ['CANCELED', 'REJECTED', 'EXPIRED', 'PENDING_CANCEL'].includes(
                  t.getOrder.status
                ) === true
              ) {
                // do cancel thing
                it('triggers cache.del due to cancelled order', () => {
                  expect(cacheMock.del).toHaveBeenCalledWith(
                    `${t.symbol}-grid-trade-last-buy-order`
                  );
                });

                it('does not trigger saveSymbolGridTrade due to cancelled order', () => {
                  expect(mockSaveSymbolGridTrade).not.toHaveBeenCalled();
                });

                it('does not trigger disableAction due to cancelled order', () => {
                  expect(mockDisableAction).not.toHaveBeenCalled();
                });

                it('triggers saveOrder due to cancelled order', () => {
                  expect(mockSaveOrder).toHaveBeenCalledWith(loggerMock, {
                    order: {
                      ...t.lastBuyOrder,
                      ...t.getOrder
                    },
                    botStatus: {
                      savedAt: expect.any(String),
                      savedBy: 'ensure-grid-trade-order-executed',
                      savedMessage:
                        'The order is no longer valid. Removed from the cache.'
                    }
                  });
                });
              } else {
                // do else thing
                it('triggers cache.set for last buy order as not filled', () => {
                  expect(cacheMock.set).toHaveBeenCalledWith(
                    `${t.symbol}-grid-trade-last-buy-order`,
                    JSON.stringify({
                      ...t.getOrder,
                      currentGridTradeIndex:
                        t.lastBuyOrder.currentGridTradeIndex,
                      // 10 secs
                      nextCheck: '2020-01-02T00:00:10.000Z'
                    })
                  );
                });

                it('does not trigger cache.del for last buy order as not filled', () => {
                  expect(cacheMock.del).not.toHaveBeenCalled();
                });

                it('does not trigger saveSymbolGridTrade as not filled', () => {
                  expect(mockSaveSymbolGridTrade).not.toHaveBeenCalled();
                });

                it('does not trigger disableAction as not filled', () => {
                  expect(mockDisableAction).not.toHaveBeenCalled();
                });

                it('triggers saveOrder as not filled', () => {
                  const { lastBuyOrder } = t;

                  const order = _.cloneDeep(lastBuyOrder);
                  _.unset(order, ['nextCheck']);
                  _.unset(order, ['currentGridTradeIndex']);

                  expect(mockSaveOrder).toHaveBeenCalledWith(loggerMock, {
                    order,
                    botStatus: {
                      savedAt: expect.any(String),
                      savedBy: 'ensure-grid-trade-order-executed',
                      savedMessage:
                        'The order is not filled. Check next internal.'
                    }
                  });
                });
              }
            } else if (
              Date.parse(t.lastBuyOrder.nextCheck) > Date.parse(momentDateTime)
            ) {
              // no need to check
              it('does not trigger binance.client.getOrder because time is not yet to check', () => {
                expect(binanceMock.client.getOrder).not.toHaveBeenCalled();
              });

              it('does not trigger cache.set because time is not yet to check', () => {
                expect(cacheMock.set).not.toHaveBeenCalled();
              });

              it('does not trigger cache.del because time is not yet to check', () => {
                expect(cacheMock.del).not.toHaveBeenCalled();
              });

              it('does not trigger saveSymbolGridTrade because time is not yet to check', () => {
                expect(mockSaveSymbolGridTrade).not.toHaveBeenCalled();
              });

              it('does not trigger disableAction because time is not yet to check', () => {
                expect(mockDisableAction).not.toHaveBeenCalled();
              });

              it('does not trigger saveOrder because time is not yet to check', () => {
                expect(mockSaveOrder).not.toHaveBeenCalled();
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
            nextCheck: '2020-01-01T23:59:00.000Z'
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
                  nextCheck: '2020-01-01T23:59:00.000Z',
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
            nextCheck: '2020-01-01T23:59:00.000Z'
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
                  nextCheck: '2020-01-01T23:59:00.000Z',
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
            nextCheck: '2020-01-02T00:01:00.000Z'
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
            nextCheck: '2020-01-01T23:59:00.000Z'
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
              nextCheck: '2020-01-01T23:59:00.000Z'
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
            nextCheck: '2020-01-01T23:59:00.000Z'
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
                  nextCheck: '2020-01-01T23:59:00.000Z',
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
            nextCheck: '2020-01-01T23:59:00.000Z'
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
                  nextCheck: '2020-01-01T23:59:00.000Z',
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
            nextCheck: '2020-01-01T23:59:00.000Z'
          },
          getOrder: 'error',
          saveSymbolGridTrade: {}
        }
      ].forEach((t, index) => {
        describe(`${t.desc}`, () => {
          beforeEach(async () => {
            cacheMock.get = jest.fn().mockImplementation(key => {
              if (key === `${t.symbol}-grid-trade-last-sell-order`) {
                return JSON.stringify(t.lastSellOrder);
              }

              return null;
            });

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
              disableAction: mockDisableAction,
              saveOrder: mockSaveOrder
            }));

            jest.mock('../../../trailingTradeHelper/configuration', () => ({
              saveSymbolGridTrade: mockSaveSymbolGridTrade
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

          it('triggers cache.get for getting cached order', () => {
            expect(cacheMock.get).toHaveBeenCalledWith(
              `${t.symbol}-grid-trade-last-sell-order`
            );
          });

          if (t.lastSellOrder === null) {
            // If last order is not found
            it('does not trigger binance.client.getOrder as order not found', () => {
              expect(binanceMock.client.getOrder).not.toHaveBeenCalled();
            });

            it('does not trigger cache.set as order not found', () => {
              expect(cacheMock.set).not.toHaveBeenCalled();
            });

            it('does not trigger cache.del as order not found', () => {
              expect(cacheMock.del).not.toHaveBeenCalled();
            });

            it('does not trigger disableAction', () => {
              expect(mockDisableAction).not.toHaveBeenCalled();
            });

            it('does not trigger saveOrder', () => {
              expect(mockSaveOrder).not.toHaveBeenCalled();
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

            it('triggers cache.del as order filled', () => {
              expect(cacheMock.del).toHaveBeenCalledWith(
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

            it('triggers saveOrder as order filled', () => {
              const { lastSellOrder } = t;

              const order = _.cloneDeep(lastSellOrder);

              expect(mockSaveOrder).toHaveBeenCalledWith(loggerMock, {
                order,
                botStatus: {
                  savedAt: expect.any(String),
                  savedBy: 'ensure-grid-trade-order-executed',
                  savedMessage:
                    'The order has already filled and updated the last buy price.'
                }
              });
            });
          } else {
            if (t.getOrder === 'error') {
              // order throws an error
              it('triggers cache.set for last sell order as order throws error', () => {
                expect(cacheMock.set).toHaveBeenCalledWith(
                  `${t.symbol}-grid-trade-last-sell-order`,
                  JSON.stringify({
                    ...t.lastSellOrder,
                    // 10 secs
                    nextCheck: '2020-01-02T00:00:10.000Z'
                  })
                );
              });

              it('does not trigger saveSymbolGridTrade as order throws error', () => {
                expect(mockSaveSymbolGridTrade).not.toHaveBeenCalled();
              });

              it('does not trigger cache.del for last sell order as order throws error', () => {
                expect(cacheMock.del).not.toHaveBeenCalled();
              });

              it('does not trigger disableAction as order throws error', () => {
                expect(mockDisableAction).not.toHaveBeenCalled();
              });

              it('triggers saveOrder as order throws error', () => {
                const { lastSellOrder } = t;

                const order = _.cloneDeep(lastSellOrder);

                expect(mockSaveOrder).toHaveBeenCalledWith(loggerMock, {
                  order,
                  botStatus: {
                    savedAt: expect.any(String),
                    savedBy: 'ensure-grid-trade-order-executed',
                    savedMessage:
                      'The order could not be found or error occurred querying the order.'
                  }
                });
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

                it('triggers cache.del as order filled after getting order result', () => {
                  expect(cacheMock.del).toHaveBeenCalledWith(
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

                it('triggers saveOrder as order filled after getting order result', () => {
                  expect(mockSaveOrder).toHaveBeenCalledWith(loggerMock, {
                    order: {
                      ...t.lastSellOrder,
                      ...t.getOrder
                    },
                    botStatus: {
                      savedAt: expect.any(String),
                      savedBy: 'ensure-grid-trade-order-executed',
                      savedMessage:
                        'The order has filled and updated the last buy price.'
                    }
                  });
                });
              } else if (
                ['CANCELED', 'REJECTED', 'EXPIRED', 'PENDING_CANCEL'].includes(
                  t.getOrder.status
                ) === true
              ) {
                // do cancel thing
                it('triggers cache.del due to cancelled order', () => {
                  expect(cacheMock.del).toHaveBeenCalledWith(
                    `${t.symbol}-grid-trade-last-sell-order`
                  );
                });

                it('does not trigger saveSymbolGridTrade due to cancelled order', () => {
                  expect(mockSaveSymbolGridTrade).not.toHaveBeenCalled();
                });

                it('does not trigger disableAction due to cancelled order', () => {
                  expect(mockDisableAction).not.toHaveBeenCalled();
                });

                it('triggers saveOrder due to cancelled order', () => {
                  expect(mockSaveOrder).toHaveBeenCalledWith(loggerMock, {
                    order: {
                      ...t.lastSellOrder,
                      ...t.getOrder
                    },
                    botStatus: {
                      savedAt: expect.any(String),
                      savedBy: 'ensure-grid-trade-order-executed',
                      savedMessage:
                        'The order is no longer valid. Removed from the cache.'
                    }
                  });
                });
              } else {
                // do else thing
                it('triggers cache.set for last sell order as not filled', () => {
                  expect(cacheMock.set).toHaveBeenCalledWith(
                    `${t.symbol}-grid-trade-last-sell-order`,
                    JSON.stringify({
                      ...t.getOrder,
                      currentGridTradeIndex:
                        t.lastSellOrder.currentGridTradeIndex,
                      // 10 secs
                      nextCheck: '2020-01-02T00:00:10.000Z'
                    })
                  );
                });

                it('does not trigger cache.del for last sell order as not filled', () => {
                  expect(cacheMock.del).not.toHaveBeenCalled();
                });

                it('does not trigger saveSymbolGridTrade as not filled', () => {
                  expect(mockSaveSymbolGridTrade).not.toHaveBeenCalled();
                });

                it('does not trigger disableAction as not filled', () => {
                  expect(mockDisableAction).not.toHaveBeenCalled();
                });

                it('triggers saveOrder as not filled', () => {
                  const { lastSellOrder } = t;

                  const order = _.cloneDeep(lastSellOrder);
                  _.unset(order, ['nextCheck']);
                  _.unset(order, ['currentGridTradeIndex']);

                  expect(mockSaveOrder).toHaveBeenCalledWith(loggerMock, {
                    order,
                    botStatus: {
                      savedAt: expect.any(String),
                      savedBy: 'ensure-grid-trade-order-executed',
                      savedMessage:
                        'The order is not filled. Check next internal.'
                    }
                  });
                });
              }
            } else if (
              Date.parse(t.lastSellOrder.nextCheck) > Date.parse(momentDateTime)
            ) {
              // no need to check
              it('does not trigger binance.client.getOrder because time is not yet to check', () => {
                expect(binanceMock.client.getOrder).not.toHaveBeenCalled();
              });

              it('does not trigger cache.set because time is not yet to check', () => {
                expect(cacheMock.set).not.toHaveBeenCalled();
              });

              it('does not trigger cache.del because time is not yet to check', () => {
                expect(cacheMock.del).not.toHaveBeenCalled();
              });

              it('does not trigger saveSymbolGridTrade because time is not yet to check', () => {
                expect(mockSaveSymbolGridTrade).not.toHaveBeenCalled();
              });

              it('does not trigger disableAction because time is not yet to check', () => {
                expect(mockDisableAction).not.toHaveBeenCalled();
              });

              it('does not trigger saveOrder because time is not yet to check', () => {
                expect(mockSaveOrder).not.toHaveBeenCalled();
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
          cacheMock.get = jest.fn().mockImplementation(key => {
            if (key === `BTCUSDT-grid-trade-last-buy-order`) {
              return JSON.stringify({
                symbol: 'BTCUSDT',
                side: 'BUY',
                status: 'NEW',
                currentGridTradeIndex: 0,
                nextCheck: '2020-01-01T23:59:00.000Z'
              });
            }
            return null;
          });

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
            disableAction: mockDisableAction,
            saveOrder: mockSaveOrder
          }));

          jest.mock('../../../trailingTradeHelper/configuration', () => ({
            saveSymbolGridTrade: mockSaveSymbolGridTrade
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
          cacheMock.get = jest.fn().mockImplementation(key => {
            if (key === `BTCUSDT-grid-trade-last-buy-order`) {
              return JSON.stringify({
                symbol: 'BTCUSDT',
                side: 'BUY',
                status: 'NEW',
                currentGridTradeIndex: 0,
                nextCheck: '2020-01-01T23:59:00.000Z'
              });
            }
            return null;
          });

          binanceMock.client.getOrder = jest.fn().mockResolvedValue({
            symbol: 'BNBUSDT',
            side: 'BUY',
            status: 'FILLED'
          });

          jest.mock('../../../trailingTradeHelper/common', () => ({
            calculateLastBuyPrice: mockCalculateLastBuyPrice,
            getAPILimit: mockGetAPILimit,
            isExceedAPILimit: mockIsExceedAPILimit,
            disableAction: mockDisableAction,
            saveOrder: mockSaveOrder
          }));

          jest.mock('../../../trailingTradeHelper/configuration', () => ({
            saveSymbolGridTrade: mockSaveSymbolGridTrade
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
          cacheMock.get = jest.fn().mockImplementation(key => {
            if (key === `BTCUSDT-grid-trade-last-buy-order`) {
              return JSON.stringify({
                symbol: 'BTCUSDT',
                side: 'BUY',
                status: 'NEW',
                currentGridTradeIndex: 0,
                nextCheck: '2020-01-01T23:59:00.000Z'
              });
            }
            return null;
          });

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
            disableAction: mockDisableAction,
            saveOrder: mockSaveOrder
          }));

          jest.mock('../../../trailingTradeHelper/configuration', () => ({
            saveSymbolGridTrade: mockSaveSymbolGridTrade
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
          cacheMock.get = jest.fn().mockImplementation(key => {
            if (key === `BTCUSDT-grid-trade-last-buy-order`) {
              return JSON.stringify({
                symbol: 'BTCUSDT',
                side: 'BUY',
                status: 'NEW',
                currentGridTradeIndex: 0,
                nextCheck: '2020-01-01T23:59:00.000Z'
              });
            }
            return null;
          });

          binanceMock.client.getOrder = jest.fn().mockResolvedValue({
            symbol: 'BNBUSDT',
            side: 'BUY',
            status: 'CANCELED'
          });

          jest.mock('../../../trailingTradeHelper/common', () => ({
            calculateLastBuyPrice: mockCalculateLastBuyPrice,
            getAPILimit: mockGetAPILimit,
            isExceedAPILimit: mockIsExceedAPILimit,
            disableAction: mockDisableAction,
            saveOrder: mockSaveOrder
          }));

          jest.mock('../../../trailingTradeHelper/configuration', () => ({
            saveSymbolGridTrade: mockSaveSymbolGridTrade
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
