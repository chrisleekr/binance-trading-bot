/* eslint-disable global-require */

describe('handle-open-orders.js', () => {
  let result;
  let rawData;
  let step;

  let binanceMock;
  let loggerMock;

  let mockGetAccountInfoFromAPI;
  let mockRefreshOpenOrdersWithSymbol;

  const accountInfoJSON = require('./fixtures/binance-account-info.json');

  describe('execute', () => {
    beforeEach(() => {
      jest.clearAllMocks().resetModules();
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

        mockRefreshOpenOrdersWithSymbol = jest.fn().mockResolvedValue(true);

        jest.mock('../../../trailingTradeHelper/common', () => ({
          getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
          refreshOpenOrdersWithSymbol: mockRefreshOpenOrdersWithSymbol
        }));

        step = require('../handle-open-orders');

        rawData = {
          symbol: 'BTCUSDT',
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

      it('does not trigger refreshOpenOrdersWithSymbol', () => {
        expect(mockRefreshOpenOrdersWithSymbol).not.toHaveBeenCalled();
      });

      it('does not trigger getAccountInfoFromAPI', () => {
        expect(mockGetAccountInfoFromAPI).not.toHaveBeenCalled();
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual({
          symbol: 'BTCUSDT',
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
            const { binance, logger } = require('../../../../helpers');
            binanceMock = binance;
            loggerMock = logger;
            binanceMock.client.cancelOrder = jest
              .fn()
              .mockRejectedValue(new Error('something happened'));

            mockGetAccountInfoFromAPI = jest
              .fn()
              .mockResolvedValue(accountInfoJSON);

            mockRefreshOpenOrdersWithSymbol = jest.fn().mockResolvedValue(true);

            jest.mock('../../../trailingTradeHelper/common', () => ({
              getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
              refreshOpenOrdersWithSymbol: mockRefreshOpenOrdersWithSymbol
            }));

            step = require('../handle-open-orders');

            rawData = {
              symbol: 'BTCUSDT',
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

          it('triggers refreshOpenOrdersWithSymbol', () => {
            expect(mockRefreshOpenOrdersWithSymbol).toHaveBeenCalled();
          });

          it('triggers getAccountInfoFromAPI', () => {
            expect(mockGetAccountInfoFromAPI).toHaveBeenCalledWith(loggerMock);
          });

          it('returns expected value', () => {
            expect(result).toStrictEqual({
              symbol: 'BTCUSDT',
              action: 'buy-order-checking',
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
              sell: { limitPrice: 1800, openOrders: [] },
              accountInfo: accountInfoJSON
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

            mockRefreshOpenOrdersWithSymbol = jest.fn().mockResolvedValue(true);

            jest.mock('../../../trailingTradeHelper/common', () => ({
              getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
              refreshOpenOrdersWithSymbol: mockRefreshOpenOrdersWithSymbol
            }));

            step = require('../handle-open-orders');

            rawData = {
              symbol: 'BTCUSDT',
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

          it('does not trigger refreshOpenOrdersWithSymbol', () => {
            expect(mockRefreshOpenOrdersWithSymbol).not.toHaveBeenCalled();
          });

          it('triggers getAccountInfoFromAPI', () => {
            expect(mockGetAccountInfoFromAPI).toHaveBeenCalledWith(loggerMock);
          });

          it('returns expected value', () => {
            expect(result).toStrictEqual({
              symbol: 'BTCUSDT',
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

          jest.mock('../../../trailingTradeHelper/common', () => ({
            getAccountInfoFromAPI: mockGetAccountInfoFromAPI
          }));

          step = require('../handle-open-orders');

          rawData = {
            symbol: 'BTCUSDT',
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

        it('does not trigger refreshOpenOrdersWithSymbol', () => {
          expect(mockRefreshOpenOrdersWithSymbol).not.toHaveBeenCalled();
        });

        it('does not trigger getAccountInfoFromAPI', () => {
          expect(mockGetAccountInfoFromAPI).not.toHaveBeenCalled();
        });

        it('returns expected value', () => {
          expect(result).toStrictEqual({
            symbol: 'BTCUSDT',
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
            const { binance, logger } = require('../../../../helpers');
            binanceMock = binance;
            loggerMock = logger;
            binanceMock.client.cancelOrder = jest
              .fn()
              .mockRejectedValue(new Error('something happened'));

            mockRefreshOpenOrdersWithSymbol = jest.fn().mockResolvedValue(true);

            mockGetAccountInfoFromAPI = jest
              .fn()
              .mockResolvedValue(accountInfoJSON);

            jest.mock('../../../trailingTradeHelper/common', () => ({
              getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
              refreshOpenOrdersWithSymbol: mockRefreshOpenOrdersWithSymbol
            }));

            step = require('../handle-open-orders');

            rawData = {
              symbol: 'BTCUSDT',
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

          it('triggers refreshOpenOrdersWithSymbol', () => {
            expect(mockRefreshOpenOrdersWithSymbol).toHaveBeenCalled();
          });

          it('triggers getAccountInfoFromAPI', () => {
            expect(mockGetAccountInfoFromAPI).toHaveBeenCalled();
          });

          it('returns expected value', () => {
            expect(result).toStrictEqual({
              symbol: 'BTCUSDT',
              action: 'sell-order-checking',
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
              },
              accountInfo: accountInfoJSON
            });
          });
        });

        describe('when cancel order is succeed', () => {
          beforeEach(async () => {
            const { binance, logger } = require('../../../../helpers');
            binanceMock = binance;
            loggerMock = logger;
            binanceMock.client.cancelOrder = jest.fn().mockResolvedValue(true);

            mockRefreshOpenOrdersWithSymbol = jest.fn().mockResolvedValue(true);

            mockGetAccountInfoFromAPI = jest
              .fn()
              .mockResolvedValue(accountInfoJSON);

            jest.mock('../../../trailingTradeHelper/common', () => ({
              getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
              refreshOpenOrdersWithSymbol: mockRefreshOpenOrdersWithSymbol
            }));

            step = require('../handle-open-orders');

            rawData = {
              symbol: 'BTCUSDT',
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
            getAccountInfoFromAPI: mockGetAccountInfoFromAPI
          }));

          step = require('../handle-open-orders');

          rawData = {
            symbol: 'BTCUSDT',
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
