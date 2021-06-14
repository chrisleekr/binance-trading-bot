/* eslint-disable global-require */

describe('handle-open-orders.js', () => {
  let result;
  let rawData;
  let step;

  let binanceMock;
  let loggerMock;
  let slackMock;

  let mockGetAccountInfoFromAPI;
  let mockGetAndCacheOpenOrdersForSymbol;
  let mockGetAPILimit;

  const accountInfoJSON = require('./fixtures/binance-account-info.json');

  describe('execute', () => {
    beforeEach(() => {
      jest.clearAllMocks().resetModules();

      mockGetAPILimit = jest.fn().mockReturnValue(10);
    });

    describe('when symbol is locked', () => {
      beforeEach(async () => {
        const { binance, logger } = require('../../../../helpers');
        binanceMock = binance;
        loggerMock = logger;
        binanceMock.client.cancelOrder = jest.fn().mockResolvedValue(true);

        mockGetAccountInfoFromAPI = jest
          .fn()
          .mockResolvedValue(accountInfoJSON);

        mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([]);

        jest.mock('../../../trailingTradeHelper/common', () => ({
          getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
          getAPILimit: mockGetAPILimit
        }));

        step = require('../handle-open-orders');

        rawData = {
          symbol: 'BTCUSDT',
          isLocked: true,
          action: 'not-determined',
          openOrders: [
            {
              symbol: 'BTCUSDT',
              orderId: 46838,
              price: '1799.58000000',
              type: 'LIMIT',
              side: 'BUY'
            }
          ],
          buy: {
            limitPrice: 1800,
            openOrders: [
              {
                symbol: 'BTCUSDT',
                orderId: 46838,
                price: '1799.58000000',
                type: 'LIMIT',
                side: 'BUY'
              }
            ]
          },
          sell: {
            limitPrice: 1800,
            openOrders: []
          }
        };

        result = await step.execute(logger, rawData);
      });

      it('does not trigger cancelOrder', () => {
        expect(binanceMock.client.cancelOrder).not.toHaveBeenCalled();
      });

      it('does not trigger getAndCacheOpenOrdersForSymbol', () => {
        expect(mockGetAndCacheOpenOrdersForSymbol).not.toHaveBeenCalled();
      });

      it('does not trigger getAccountInfoFromAPI', () => {
        expect(mockGetAccountInfoFromAPI).not.toHaveBeenCalled();
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual({
          symbol: 'BTCUSDT',
          isLocked: true,
          action: 'not-determined',
          openOrders: [
            {
              symbol: 'BTCUSDT',
              orderId: 46838,
              price: '1799.58000000',
              type: 'LIMIT',
              side: 'BUY'
            }
          ],
          buy: {
            limitPrice: 1800,
            openOrders: [
              {
                symbol: 'BTCUSDT',
                orderId: 46838,
                price: '1799.58000000',
                type: 'LIMIT',
                side: 'BUY'
              }
            ]
          },
          sell: { limitPrice: 1800, openOrders: [] }
        });
      });
    });

    describe('when action is not not-determined', () => {
      beforeEach(async () => {
        const { binance, logger } = require('../../../../helpers');
        binanceMock = binance;
        loggerMock = logger;
        binanceMock.client.cancelOrder = jest.fn().mockResolvedValue(true);

        mockGetAccountInfoFromAPI = jest
          .fn()
          .mockResolvedValue(accountInfoJSON);

        mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([]);

        jest.mock('../../../trailingTradeHelper/common', () => ({
          getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
          getAPILimit: mockGetAPILimit
        }));

        step = require('../handle-open-orders');

        rawData = {
          symbol: 'BTCUSDT',
          isLocked: false,
          action: 'buy-wait',
          openOrders: [
            {
              symbol: 'BTCUSDT',
              orderId: 46838,
              price: '1799.58000000',
              type: 'LIMIT',
              side: 'BUY'
            }
          ],
          buy: {
            limitPrice: 1800,
            openOrders: [
              {
                symbol: 'BTCUSDT',
                orderId: 46838,
                price: '1799.58000000',
                type: 'LIMIT',
                side: 'BUY'
              }
            ]
          },
          sell: {
            limitPrice: 1800,
            openOrders: []
          }
        };

        result = await step.execute(logger, rawData);
      });

      it('does not trigger cancelOrder', () => {
        expect(binanceMock.client.cancelOrder).not.toHaveBeenCalled();
      });

      it('does not trigger getAndCacheOpenOrdersForSymbol', () => {
        expect(mockGetAndCacheOpenOrdersForSymbol).not.toHaveBeenCalled();
      });

      it('does not trigger getAccountInfoFromAPI', () => {
        expect(mockGetAccountInfoFromAPI).not.toHaveBeenCalled();
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual({
          symbol: 'BTCUSDT',
          isLocked: false,
          action: 'buy-wait',
          openOrders: [
            {
              symbol: 'BTCUSDT',
              orderId: 46838,
              price: '1799.58000000',
              type: 'LIMIT',
              side: 'BUY'
            }
          ],
          buy: {
            limitPrice: 1800,
            openOrders: [
              {
                symbol: 'BTCUSDT',
                orderId: 46838,
                price: '1799.58000000',
                type: 'LIMIT',
                side: 'BUY'
              }
            ]
          },
          sell: { limitPrice: 1800, openOrders: [] }
        });
      });
    });

    describe('when order is not STOP_LOSS_LIMIT', () => {
      beforeEach(async () => {
        const { binance, logger } = require('../../../../helpers');
        binanceMock = binance;
        loggerMock = logger;
        binanceMock.client.cancelOrder = jest.fn().mockResolvedValue(true);

        mockGetAccountInfoFromAPI = jest
          .fn()
          .mockResolvedValue(accountInfoJSON);

        mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([]);

        jest.mock('../../../trailingTradeHelper/common', () => ({
          getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
          getAPILimit: mockGetAPILimit
        }));

        step = require('../handle-open-orders');

        rawData = {
          symbol: 'BTCUSDT',
          isLocked: false,
          action: 'not-determined',
          openOrders: [
            {
              symbol: 'BTCUSDT',
              orderId: 46838,
              price: '1799.58000000',
              type: 'LIMIT',
              side: 'BUY'
            }
          ],
          buy: {
            limitPrice: 1800,
            openOrders: [
              {
                symbol: 'BTCUSDT',
                orderId: 46838,
                price: '1799.58000000',
                type: 'LIMIT',
                side: 'BUY'
              }
            ]
          },
          sell: {
            limitPrice: 1800,
            openOrders: []
          }
        };

        result = await step.execute(logger, rawData);
      });

      it('does not trigger cancelOrder', () => {
        expect(binanceMock.client.cancelOrder).not.toHaveBeenCalled();
      });

      it('does not trigger getAndCacheOpenOrdersForSymbol', () => {
        expect(mockGetAndCacheOpenOrdersForSymbol).not.toHaveBeenCalled();
      });

      it('does not trigger getAccountInfoFromAPI', () => {
        expect(mockGetAccountInfoFromAPI).not.toHaveBeenCalled();
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual({
          symbol: 'BTCUSDT',
          isLocked: false,
          action: 'not-determined',
          openOrders: [
            {
              symbol: 'BTCUSDT',
              orderId: 46838,
              price: '1799.58000000',
              type: 'LIMIT',
              side: 'BUY'
            }
          ],
          buy: {
            limitPrice: 1800,
            openOrders: [
              {
                symbol: 'BTCUSDT',
                orderId: 46838,
                price: '1799.58000000',
                type: 'LIMIT',
                side: 'BUY'
              }
            ]
          },
          sell: { limitPrice: 1800, openOrders: [] }
        });
      });
    });

    describe('when order is buy', () => {
      describe('when stop price is higher or equal than current limit price', () => {
        describe('when cancelling order is failed', () => {
          beforeEach(async () => {
            const { binance, logger, slack } = require('../../../../helpers');
            binanceMock = binance;
            loggerMock = logger;
            slackMock = slack;

            slackMock.sendMessage = jest.fn().mockResolvedValue(true);

            binanceMock.client.cancelOrder = jest
              .fn()
              .mockRejectedValue(new Error('something happened'));

            mockGetAccountInfoFromAPI = jest
              .fn()
              .mockResolvedValue(accountInfoJSON);

            mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([
              {
                symbol: 'BTCUSDT',
                orderId: 46839,
                price: '1799.58000000',
                stopPrice: '1800.1000',
                type: 'STOP_LOSS_LIMIT',
                side: 'BUY'
              },
              {
                symbol: 'BTCUSDT',
                orderId: 46841,
                price: '1799.58000000',
                stopPrice: '1800.1000',
                type: 'STOP_LOSS_LIMIT',
                side: 'SELL'
              }
            ]);

            jest.mock('../../../trailingTradeHelper/common', () => ({
              getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
              getAndCacheOpenOrdersForSymbol:
                mockGetAndCacheOpenOrdersForSymbol,
              getAPILimit: mockGetAPILimit
            }));

            step = require('../handle-open-orders');
          });

          describe('when notifyDebug is true', () => {
            beforeEach(async () => {
              rawData = {
                symbol: 'BTCUSDT',
                isLocked: false,
                featureToggle: {
                  notifyDebug: true
                },
                action: 'not-determined',
                openOrders: [
                  {
                    symbol: 'BTCUSDT',
                    orderId: 46838,
                    price: '1799.58000000',
                    stopPrice: '1800.1000',
                    type: 'STOP_LOSS_LIMIT',
                    side: 'BUY'
                  }
                ],
                buy: {
                  limitPrice: 1800,
                  openOrders: [
                    {
                      symbol: 'BTCUSDT',
                      orderId: 46838,
                      price: '1799.58000000',
                      stopPrice: '1800.1000',
                      type: 'STOP_LOSS_LIMIT',
                      side: 'BUY'
                    }
                  ]
                },
                sell: {
                  limitPrice: 1800,
                  openOrders: []
                }
              };

              result = await step.execute(loggerMock, rawData);
            });

            it('triggers cancelOrder', () => {
              expect(binanceMock.client.cancelOrder).toHaveBeenCalledWith({
                symbol: 'BTCUSDT',
                orderId: 46838
              });
            });

            it('triggers getAndCacheOpenOrdersForSymbol', () => {
              expect(mockGetAndCacheOpenOrdersForSymbol).toHaveBeenCalled();
            });

            it('triggers getAccountInfoFromAPI', () => {
              expect(mockGetAccountInfoFromAPI).toHaveBeenCalledWith(
                loggerMock
              );
            });

            it('triggers slack.sendMessage', () => {
              expect(slackMock.sendMessage).toHaveBeenCalled();
            });

            it('returns expected value', () => {
              expect(result).toStrictEqual({
                symbol: 'BTCUSDT',
                isLocked: false,
                featureToggle: {
                  notifyDebug: true
                },
                action: 'buy-order-checking',
                openOrders: [
                  {
                    symbol: 'BTCUSDT',
                    orderId: 46839,
                    price: '1799.58000000',
                    stopPrice: '1800.1000',
                    type: 'STOP_LOSS_LIMIT',
                    side: 'BUY'
                  },
                  {
                    symbol: 'BTCUSDT',
                    orderId: 46841,
                    price: '1799.58000000',
                    stopPrice: '1800.1000',
                    type: 'STOP_LOSS_LIMIT',
                    side: 'SELL'
                  }
                ],
                buy: {
                  limitPrice: 1800,
                  openOrders: [
                    {
                      symbol: 'BTCUSDT',
                      orderId: 46839,
                      price: '1799.58000000',
                      stopPrice: '1800.1000',
                      type: 'STOP_LOSS_LIMIT',
                      side: 'BUY'
                    }
                  ]
                },
                sell: { limitPrice: 1800, openOrders: [] },
                accountInfo: accountInfoJSON
              });
            });
          });

          describe('when notifyDebug is false', () => {
            beforeEach(async () => {
              rawData = {
                symbol: 'BTCUSDT',
                isLocked: false,
                featureToggle: {
                  notifyDebug: false
                },
                action: 'not-determined',
                openOrders: [
                  {
                    symbol: 'BTCUSDT',
                    orderId: 46838,
                    price: '1799.58000000',
                    stopPrice: '1800.1000',
                    type: 'STOP_LOSS_LIMIT',
                    side: 'BUY'
                  }
                ],
                buy: {
                  limitPrice: 1800,
                  openOrders: [
                    {
                      symbol: 'BTCUSDT',
                      orderId: 46838,
                      price: '1799.58000000',
                      stopPrice: '1800.1000',
                      type: 'STOP_LOSS_LIMIT',
                      side: 'BUY'
                    }
                  ]
                },
                sell: {
                  limitPrice: 1800,
                  openOrders: []
                }
              };

              result = await step.execute(loggerMock, rawData);
            });

            it('triggers cancelOrder', () => {
              expect(binanceMock.client.cancelOrder).toHaveBeenCalledWith({
                symbol: 'BTCUSDT',
                orderId: 46838
              });
            });

            it('triggers getAndCacheOpenOrdersForSymbol', () => {
              expect(mockGetAndCacheOpenOrdersForSymbol).toHaveBeenCalled();
            });

            it('triggers getAccountInfoFromAPI', () => {
              expect(mockGetAccountInfoFromAPI).toHaveBeenCalledWith(
                loggerMock
              );
            });

            it('does not trigger slack.sendMessage', () => {
              expect(slackMock.sendMessage).not.toHaveBeenCalled();
            });

            it('returns expected value', () => {
              expect(result).toStrictEqual({
                symbol: 'BTCUSDT',
                isLocked: false,
                featureToggle: {
                  notifyDebug: false
                },
                action: 'buy-order-checking',
                openOrders: [
                  {
                    symbol: 'BTCUSDT',
                    orderId: 46839,
                    price: '1799.58000000',
                    stopPrice: '1800.1000',
                    type: 'STOP_LOSS_LIMIT',
                    side: 'BUY'
                  },
                  {
                    symbol: 'BTCUSDT',
                    orderId: 46841,
                    price: '1799.58000000',
                    stopPrice: '1800.1000',
                    type: 'STOP_LOSS_LIMIT',
                    side: 'SELL'
                  }
                ],
                buy: {
                  limitPrice: 1800,
                  openOrders: [
                    {
                      symbol: 'BTCUSDT',
                      orderId: 46839,
                      price: '1799.58000000',
                      stopPrice: '1800.1000',
                      type: 'STOP_LOSS_LIMIT',
                      side: 'BUY'
                    }
                  ]
                },
                sell: { limitPrice: 1800, openOrders: [] },
                accountInfo: accountInfoJSON
              });
            });
          });
        });

        describe('when cancelling order is succeed', () => {
          beforeEach(async () => {
            const { binance, logger } = require('../../../../helpers');
            binanceMock = binance;
            loggerMock = logger;
            binanceMock.client.cancelOrder = jest.fn().mockResolvedValue(true);

            mockGetAccountInfoFromAPI = jest
              .fn()
              .mockResolvedValue(accountInfoJSON);

            mockGetAndCacheOpenOrdersForSymbol = jest
              .fn()
              .mockResolvedValue([]);

            jest.mock('../../../trailingTradeHelper/common', () => ({
              getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
              getAndCacheOpenOrdersForSymbol:
                mockGetAndCacheOpenOrdersForSymbol,
              getAPILimit: mockGetAPILimit
            }));

            step = require('../handle-open-orders');

            rawData = {
              symbol: 'BTCUSDT',
              isLocked: false,
              action: 'not-determined',
              openOrders: [
                {
                  symbol: 'BTCUSDT',
                  orderId: 46838,
                  price: '1799.58000000',
                  stopPrice: '1800.1000',
                  type: 'STOP_LOSS_LIMIT',
                  side: 'BUY'
                }
              ],
              buy: {
                limitPrice: 1800,
                openOrders: [
                  {
                    symbol: 'BTCUSDT',
                    orderId: 46838,
                    price: '1799.58000000',
                    stopPrice: '1800.1000',
                    type: 'STOP_LOSS_LIMIT',
                    side: 'BUY'
                  }
                ]
              },
              sell: {
                limitPrice: 1800,
                openOrders: []
              }
            };

            result = await step.execute(logger, rawData);
          });

          it('triggers cancelOrder', () => {
            expect(binanceMock.client.cancelOrder).toHaveBeenCalledWith({
              symbol: 'BTCUSDT',
              orderId: 46838
            });
          });

          it('does not trigger getAndCacheOpenOrdersForSymbol', () => {
            expect(mockGetAndCacheOpenOrdersForSymbol).not.toHaveBeenCalled();
          });

          it('triggers getAccountInfoFromAPI', () => {
            expect(mockGetAccountInfoFromAPI).toHaveBeenCalledWith(loggerMock);
          });

          it('returns expected value', () => {
            expect(result).toStrictEqual({
              symbol: 'BTCUSDT',
              isLocked: false,
              action: 'buy',
              openOrders: [
                {
                  symbol: 'BTCUSDT',
                  orderId: 46838,
                  price: '1799.58000000',
                  stopPrice: '1800.1000',
                  type: 'STOP_LOSS_LIMIT',
                  side: 'BUY'
                }
              ],
              buy: { limitPrice: 1800, openOrders: [] },
              sell: { limitPrice: 1800, openOrders: [] },
              accountInfo: accountInfoJSON
            });
          });
        });
      });

      describe('when stop price is less than current limit price', () => {
        beforeEach(async () => {
          const { binance, logger } = require('../../../../helpers');
          binanceMock = binance;
          loggerMock = logger;
          binanceMock.client.cancelOrder = jest.fn().mockResolvedValue(true);

          mockGetAccountInfoFromAPI = jest
            .fn()
            .mockResolvedValue(accountInfoJSON);
          mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([]);

          jest.mock('../../../trailingTradeHelper/common', () => ({
            getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
            getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
            getAPILimit: mockGetAPILimit
          }));

          step = require('../handle-open-orders');

          rawData = {
            symbol: 'BTCUSDT',
            isLocked: false,
            action: 'not-determined',
            openOrders: [
              {
                symbol: 'BTCUSDT',
                orderId: 46838,
                price: '1799.58000000',
                stopPrice: '1800.1000',
                type: 'STOP_LOSS_LIMIT',
                side: 'BUY'
              }
            ],
            buy: {
              limitPrice: 1810,
              openOrders: [
                {
                  symbol: 'BTCUSDT',
                  orderId: 46838,
                  price: '1799.58000000',
                  stopPrice: '1800.1000',
                  type: 'STOP_LOSS_LIMIT',
                  side: 'BUY'
                }
              ]
            },
            sell: {
              limitPrice: 1800,
              openOrders: []
            }
          };

          result = await step.execute(logger, rawData);
        });

        it('does not trigger cancelOrder', () => {
          expect(binanceMock.client.cancelOrder).not.toHaveBeenCalled();
        });

        it('does not trigger getAndCacheOpenOrdersForSymbol', () => {
          expect(mockGetAndCacheOpenOrdersForSymbol).not.toHaveBeenCalled();
        });

        it('does not trigger getAccountInfoFromAPI', () => {
          expect(mockGetAccountInfoFromAPI).not.toHaveBeenCalled();
        });

        it('returns expected value', () => {
          expect(result).toStrictEqual({
            symbol: 'BTCUSDT',
            isLocked: false,
            action: 'buy-order-wait',
            openOrders: [
              {
                symbol: 'BTCUSDT',
                orderId: 46838,
                price: '1799.58000000',
                stopPrice: '1800.1000',
                type: 'STOP_LOSS_LIMIT',
                side: 'BUY'
              }
            ],
            buy: {
              limitPrice: 1810,
              openOrders: [
                {
                  symbol: 'BTCUSDT',
                  orderId: 46838,
                  price: '1799.58000000',
                  stopPrice: '1800.1000',
                  type: 'STOP_LOSS_LIMIT',
                  side: 'BUY'
                }
              ]
            },
            sell: { limitPrice: 1800, openOrders: [] }
          });
        });
      });
    });

    describe('when order is sell', () => {
      describe('when stop price is less or equal than current limit price', () => {
        describe('when cancel order is failed', () => {
          beforeEach(async () => {
            const { binance, logger, slack } = require('../../../../helpers');
            binanceMock = binance;
            loggerMock = logger;
            slackMock = slack;

            slack.sendMessage = jest.fn().mockResolvedValue(true);

            binanceMock.client.cancelOrder = jest
              .fn()
              .mockRejectedValue(new Error('something happened'));

            mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([
              {
                symbol: 'BTCUSDT',
                orderId: 46840,
                price: '1799.58000000',
                stopPrice: '1800.1000',
                type: 'STOP_LOSS_LIMIT',
                side: 'SELL'
              },
              {
                symbol: 'BTCUSDT',
                orderId: 46841,
                price: '1799.58000000',
                stopPrice: '1800.1000',
                type: 'STOP_LOSS_LIMIT',
                side: 'BUY'
              }
            ]);

            mockGetAccountInfoFromAPI = jest
              .fn()
              .mockResolvedValue(accountInfoJSON);

            jest.mock('../../../trailingTradeHelper/common', () => ({
              getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
              getAndCacheOpenOrdersForSymbol:
                mockGetAndCacheOpenOrdersForSymbol,
              getAPILimit: mockGetAPILimit
            }));

            step = require('../handle-open-orders');
          });

          describe('when notifyDebug is true', () => {
            beforeEach(async () => {
              rawData = {
                symbol: 'BTCUSDT',
                isLocked: false,
                featureToggle: {
                  notifyDebug: true
                },
                action: 'not-determined',
                openOrders: [
                  {
                    symbol: 'BTCUSDT',
                    orderId: 46838,
                    price: '1799.58000000',
                    stopPrice: '1800.1000',
                    type: 'STOP_LOSS_LIMIT',
                    side: 'SELL'
                  }
                ],
                buy: {
                  limitPrice: 1800,
                  openOrders: []
                },
                sell: {
                  limitPrice: 1801,
                  openOrders: [
                    {
                      symbol: 'BTCUSDT',
                      orderId: 46838,
                      price: '1799.58000000',
                      stopPrice: '1800.1000',
                      type: 'STOP_LOSS_LIMIT',
                      side: 'SELL'
                    }
                  ]
                }
              };

              result = await step.execute(loggerMock, rawData);
            });

            it('triggers cancelOrder', () => {
              expect(binanceMock.client.cancelOrder).toHaveBeenCalledWith({
                symbol: 'BTCUSDT',
                orderId: 46838
              });
            });

            it('triggers getAndCacheOpenOrdersForSymbol', () => {
              expect(mockGetAndCacheOpenOrdersForSymbol).toHaveBeenCalled();
            });

            it('triggers getAccountInfoFromAPI', () => {
              expect(mockGetAccountInfoFromAPI).toHaveBeenCalled();
            });

            it('triggers slack.sendMessage', () => {
              expect(slackMock.sendMessage).toHaveBeenCalled();
            });

            it('returns expected value', () => {
              expect(result).toStrictEqual({
                symbol: 'BTCUSDT',
                isLocked: false,
                featureToggle: {
                  notifyDebug: true
                },
                action: 'sell-order-checking',
                openOrders: [
                  {
                    symbol: 'BTCUSDT',
                    orderId: 46840,
                    price: '1799.58000000',
                    stopPrice: '1800.1000',
                    type: 'STOP_LOSS_LIMIT',
                    side: 'SELL'
                  },
                  {
                    symbol: 'BTCUSDT',
                    orderId: 46841,
                    price: '1799.58000000',
                    stopPrice: '1800.1000',
                    type: 'STOP_LOSS_LIMIT',
                    side: 'BUY'
                  }
                ],
                buy: { limitPrice: 1800, openOrders: [] },
                sell: {
                  limitPrice: 1801,
                  openOrders: [
                    {
                      symbol: 'BTCUSDT',
                      orderId: 46840,
                      price: '1799.58000000',
                      stopPrice: '1800.1000',
                      type: 'STOP_LOSS_LIMIT',
                      side: 'SELL'
                    }
                  ]
                },
                accountInfo: accountInfoJSON
              });
            });
          });

          describe('when notifyDebug is false', () => {
            beforeEach(async () => {
              rawData = {
                symbol: 'BTCUSDT',
                isLocked: false,
                featureToggle: {
                  notifyDebug: false
                },
                action: 'not-determined',
                openOrders: [
                  {
                    symbol: 'BTCUSDT',
                    orderId: 46838,
                    price: '1799.58000000',
                    stopPrice: '1800.1000',
                    type: 'STOP_LOSS_LIMIT',
                    side: 'SELL'
                  }
                ],
                buy: {
                  limitPrice: 1800,
                  openOrders: []
                },
                sell: {
                  limitPrice: 1801,
                  openOrders: [
                    {
                      symbol: 'BTCUSDT',
                      orderId: 46838,
                      price: '1799.58000000',
                      stopPrice: '1800.1000',
                      type: 'STOP_LOSS_LIMIT',
                      side: 'SELL'
                    }
                  ]
                }
              };

              result = await step.execute(loggerMock, rawData);
            });

            it('triggers cancelOrder', () => {
              expect(binanceMock.client.cancelOrder).toHaveBeenCalledWith({
                symbol: 'BTCUSDT',
                orderId: 46838
              });
            });

            it('triggers getAndCacheOpenOrdersForSymbol', () => {
              expect(mockGetAndCacheOpenOrdersForSymbol).toHaveBeenCalled();
            });

            it('triggers getAccountInfoFromAPI', () => {
              expect(mockGetAccountInfoFromAPI).toHaveBeenCalled();
            });

            it('does not trigger slack.sendMessage', () => {
              expect(slackMock.sendMessage).not.toHaveBeenCalled();
            });

            it('returns expected value', () => {
              expect(result).toStrictEqual({
                symbol: 'BTCUSDT',
                isLocked: false,
                featureToggle: {
                  notifyDebug: false
                },
                action: 'sell-order-checking',
                openOrders: [
                  {
                    symbol: 'BTCUSDT',
                    orderId: 46840,
                    price: '1799.58000000',
                    stopPrice: '1800.1000',
                    type: 'STOP_LOSS_LIMIT',
                    side: 'SELL'
                  },
                  {
                    symbol: 'BTCUSDT',
                    orderId: 46841,
                    price: '1799.58000000',
                    stopPrice: '1800.1000',
                    type: 'STOP_LOSS_LIMIT',
                    side: 'BUY'
                  }
                ],
                buy: { limitPrice: 1800, openOrders: [] },
                sell: {
                  limitPrice: 1801,
                  openOrders: [
                    {
                      symbol: 'BTCUSDT',
                      orderId: 46840,
                      price: '1799.58000000',
                      stopPrice: '1800.1000',
                      type: 'STOP_LOSS_LIMIT',
                      side: 'SELL'
                    }
                  ]
                },
                accountInfo: accountInfoJSON
              });
            });
          });
        });

        describe('when cancel order is succeed', () => {
          beforeEach(async () => {
            const { binance, logger } = require('../../../../helpers');
            binanceMock = binance;
            loggerMock = logger;
            binanceMock.client.cancelOrder = jest.fn().mockResolvedValue(true);

            mockGetAndCacheOpenOrdersForSymbol = jest
              .fn()
              .mockResolvedValue([]);

            mockGetAccountInfoFromAPI = jest
              .fn()
              .mockResolvedValue(accountInfoJSON);

            jest.mock('../../../trailingTradeHelper/common', () => ({
              getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
              getAndCacheOpenOrdersForSymbol:
                mockGetAndCacheOpenOrdersForSymbol,
              getAPILimit: mockGetAPILimit
            }));

            step = require('../handle-open-orders');

            rawData = {
              symbol: 'BTCUSDT',
              isLocked: false,
              action: 'not-determined',
              openOrders: [
                {
                  symbol: 'BTCUSDT',
                  orderId: 46838,
                  price: '1799.58000000',
                  stopPrice: '1800.1000',
                  type: 'STOP_LOSS_LIMIT',
                  side: 'SELL'
                }
              ],
              buy: {
                limitPrice: 1800,
                openOrders: []
              },
              sell: {
                limitPrice: 1801,
                openOrders: [
                  {
                    symbol: 'BTCUSDT',
                    orderId: 46838,
                    price: '1799.58000000',
                    stopPrice: '1800.1000',
                    type: 'STOP_LOSS_LIMIT',
                    side: 'SELL'
                  }
                ]
              }
            };

            result = await step.execute(logger, rawData);
          });

          it('triggers cancelOrder', () => {
            expect(binanceMock.client.cancelOrder).toHaveBeenCalledWith({
              symbol: 'BTCUSDT',
              orderId: 46838
            });
          });

          it('returns expected value', () => {
            expect(result).toStrictEqual({
              symbol: 'BTCUSDT',
              isLocked: false,
              action: 'sell',
              openOrders: [
                {
                  symbol: 'BTCUSDT',
                  orderId: 46838,
                  price: '1799.58000000',
                  stopPrice: '1800.1000',
                  type: 'STOP_LOSS_LIMIT',
                  side: 'SELL'
                }
              ],
              buy: { limitPrice: 1800, openOrders: [] },
              sell: { limitPrice: 1801, openOrders: [] },
              accountInfo: accountInfoJSON
            });
          });
        });
      });

      describe('when stop price is more than current limit price', () => {
        beforeEach(async () => {
          const { binance, logger } = require('../../../../helpers');
          binanceMock = binance;
          loggerMock = logger;
          binanceMock.client.cancelOrder = jest.fn().mockResolvedValue(true);

          mockGetAccountInfoFromAPI = jest
            .fn()
            .mockResolvedValue(accountInfoJSON);

          jest.mock('../../../trailingTradeHelper/common', () => ({
            getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
            getAPILimit: mockGetAPILimit
          }));

          step = require('../handle-open-orders');

          rawData = {
            symbol: 'BTCUSDT',
            isLocked: false,
            action: 'not-determined',
            openOrders: [
              {
                symbol: 'BTCUSDT',
                orderId: 46838,
                price: '1799.58000000',
                stopPrice: '1800.1000',
                type: 'STOP_LOSS_LIMIT',
                side: 'SELL'
              }
            ],
            buy: {
              limitPrice: 1800,
              openOrders: []
            },
            sell: {
              limitPrice: 1799,
              openOrders: [
                {
                  symbol: 'BTCUSDT',
                  orderId: 46838,
                  price: '1799.58000000',
                  stopPrice: '1800.1000',
                  type: 'STOP_LOSS_LIMIT',
                  side: 'SELL'
                }
              ]
            }
          };

          result = await step.execute(logger, rawData);
        });

        it('does not trigger cancelOrder', () => {
          expect(binanceMock.client.cancelOrder).not.toHaveBeenCalled();
        });

        it('does not trigger getAccountInfoFromAPI', () => {
          expect(mockGetAccountInfoFromAPI).not.toHaveBeenCalled();
        });

        it('returns expected value', () => {
          expect(result).toStrictEqual({
            symbol: 'BTCUSDT',
            isLocked: false,
            action: 'sell-order-wait',
            openOrders: [
              {
                symbol: 'BTCUSDT',
                orderId: 46838,
                price: '1799.58000000',
                stopPrice: '1800.1000',
                type: 'STOP_LOSS_LIMIT',
                side: 'SELL'
              }
            ],
            buy: { limitPrice: 1800, openOrders: [] },
            sell: {
              limitPrice: 1799,
              openOrders: [
                {
                  symbol: 'BTCUSDT',
                  orderId: 46838,
                  price: '1799.58000000',
                  stopPrice: '1800.1000',
                  type: 'STOP_LOSS_LIMIT',
                  side: 'SELL'
                }
              ]
            }
          });
        });
      });
    });
  });
});
