/* eslint-disable global-require */

describe('handle-open-orders.js', () => {
  let result;
  let rawData;
  let step;

  let loggerMock;
  let slackMock;

  let mockCancelOrder;
  let mockRefreshOpenOrdersAndAccountInfo;
  let mockGetAccountInfoFromAPI;

  let mockIsExceedingMaxOpenTrades;

  describe('execute', () => {
    beforeEach(() => {
      jest.clearAllMocks().resetModules();

      const { logger, slack } = require('../../../../helpers');
      loggerMock = logger;
      slackMock = slack;

      mockRefreshOpenOrdersAndAccountInfo = jest.fn().mockResolvedValue({
        accountInfo: {
          accountInfo: 'updated'
        },
        openOrders: [{ openOrders: 'retrieved' }],
        buyOpenOrders: [{ buyOpenOrders: 'retrived' }],
        sellOpenOrders: [{ sellOpenOrders: 'retrived' }]
      });
      mockCancelOrder = jest.fn().mockResolvedValue(true);

      mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
        account: 'updated'
      });

      mockIsExceedingMaxOpenTrades = jest.fn().mockResolvedValue(false);
    });

    describe('when action is not not-determined', () => {
      beforeEach(async () => {
        jest.mock('../../../trailingTradeHelper/common', () => ({
          getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
          isExceedingMaxOpenTrades: mockIsExceedingMaxOpenTrades,
          cancelOrder: mockCancelOrder,
          refreshOpenOrdersAndAccountInfo: mockRefreshOpenOrdersAndAccountInfo
        }));

        step = require('../handle-open-orders');

        rawData = {
          symbol: 'BTCUSDT',
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
          },
          symbolInfo: {
            quoteAsset: 'USDT'
          }
        };

        result = await step.execute(loggerMock, rawData);
      });

      it('does not trigger cancelOrder', () => {
        expect(mockCancelOrder).not.toHaveBeenCalled();
      });

      it('does not trigger refreshOpenOrdersAndAccountInfo', () => {
        expect(mockRefreshOpenOrdersAndAccountInfo).not.toHaveBeenCalled();
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual({
          symbol: 'BTCUSDT',
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
          sell: { limitPrice: 1800, openOrders: [] },
          symbolInfo: {
            quoteAsset: 'USDT'
          }
        });
      });
    });

    describe('when order is not STOP_LOSS_LIMIT', () => {
      beforeEach(async () => {
        jest.mock('../../../trailingTradeHelper/common', () => ({
          getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
          isExceedingMaxOpenTrades: mockIsExceedingMaxOpenTrades,
          cancelOrder: mockCancelOrder,
          refreshOpenOrdersAndAccountInfo: mockRefreshOpenOrdersAndAccountInfo
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
          },
          symbolInfo: {
            quoteAsset: 'USDT'
          }
        };

        result = await step.execute(loggerMock, rawData);
      });

      it('does not trigger cancelOrder', () => {
        expect(mockCancelOrder).not.toHaveBeenCalled();
      });

      it('does not trigger refreshOpenOrdersAndAccountInfo', () => {
        expect(mockRefreshOpenOrdersAndAccountInfo).not.toHaveBeenCalled();
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
          sell: { limitPrice: 1800, openOrders: [] },
          symbolInfo: {
            quoteAsset: 'USDT'
          }
        });
      });
    });

    describe('when order is buy', () => {
      describe('when open trade limit is reached', () => {
        describe('when cancelling order is failed', () => {
          beforeEach(async () => {
            mockIsExceedingMaxOpenTrades = jest.fn().mockResolvedValue(true);
            mockCancelOrder = jest.fn().mockResolvedValue(false);

            jest.mock('../../../trailingTradeHelper/common', () => ({
              getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
              isExceedingMaxOpenTrades: mockIsExceedingMaxOpenTrades,
              cancelOrder: mockCancelOrder,
              refreshOpenOrdersAndAccountInfo:
                mockRefreshOpenOrdersAndAccountInfo
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
              },
              symbolInfo: {
                quoteAsset: 'USDT'
              }
            };

            result = await step.execute(loggerMock, rawData);
          });

          it('does trigger cancelOrder', () => {
            expect(mockCancelOrder).toHaveBeenCalled();
          });

          it('triggers refreshOpenOrdersAndAccountInfo', () => {
            expect(mockRefreshOpenOrdersAndAccountInfo).toHaveBeenCalledWith(
              loggerMock,
              'BTCUSDT'
            );
          });

          it('returns expected value', () => {
            expect(result).toStrictEqual({
              symbol: 'BTCUSDT',
              action: 'buy-order-checking',
              openOrders: [
                {
                  openOrders: 'retrieved'
                }
              ],
              buy: {
                limitPrice: 1810,
                openOrders: [
                  {
                    buyOpenOrders: 'retrived'
                  }
                ]
              },
              sell: { limitPrice: 1800, openOrders: [] },
              symbolInfo: {
                quoteAsset: 'USDT'
              },
              accountInfo: { accountInfo: 'updated' }
            });
          });
        });

        describe('when cancelling order is succeeded', () => {
          beforeEach(async () => {
            mockIsExceedingMaxOpenTrades = jest.fn().mockResolvedValue(true);
            mockCancelOrder = jest.fn().mockResolvedValue(true);

            jest.mock('../../../trailingTradeHelper/common', () => ({
              getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
              isExceedingMaxOpenTrades: mockIsExceedingMaxOpenTrades,
              cancelOrder: mockCancelOrder,
              refreshOpenOrdersAndAccountInfo:
                mockRefreshOpenOrdersAndAccountInfo
            }));

            step = require('../handle-open-orders');

            rawData = {
              symbol: 'BTCUSDT',
              action: 'not-determined',
              openOrders: [
                {
                  symbol: 'BTCUSDT',
                  orderId: 46838,
                  origQty: '0.00001',
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
                    origQty: '0.00001',
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
              },
              symbolInfo: {
                quoteAsset: 'USDT'
              },
              quoteAssetBalance: {
                free: 50,
                locked: 0.0179958
              }
            };

            result = await step.execute(loggerMock, rawData);
          });

          it('does trigger cancelOrder', () => {
            expect(mockCancelOrder).toHaveBeenCalled();
          });

          it('does not trigger refreshOpenOrdersAndAccountInfo', () => {
            expect(mockRefreshOpenOrdersAndAccountInfo).not.toHaveBeenCalled();
          });

          it('triggers getAccountInfoFromAPI', () => {
            expect(mockGetAccountInfoFromAPI).toHaveBeenCalledWith(loggerMock);
          });

          it('returns expected value', () => {
            expect(result).toStrictEqual({
              symbol: 'BTCUSDT',
              action: 'buy-order-cancelled',
              openOrders: [
                {
                  symbol: 'BTCUSDT',
                  orderId: 46838,
                  origQty: '0.00001',
                  price: '1799.58000000',
                  stopPrice: '1800.1000',
                  type: 'STOP_LOSS_LIMIT',
                  side: 'BUY'
                }
              ],
              buy: {
                limitPrice: 1810,
                openOrders: []
              },
              sell: { limitPrice: 1800, openOrders: [] },
              symbolInfo: {
                quoteAsset: 'USDT'
              },
              accountInfo: {
                account: 'updated'
              },
              quoteAssetBalance: {
                free: 50,
                locked: 0.0179958
              }
            });
          });
        });
      });

      describe('when stop price is higher than current limit price', () => {
        describe('when cancelling order is failed', () => {
          beforeEach(async () => {
            slackMock.sendMessage = jest.fn().mockResolvedValue(true);

            mockCancelOrder = jest.fn().mockResolvedValue(false);

            jest.mock('../../../trailingTradeHelper/common', () => ({
              getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
              isExceedingMaxOpenTrades: mockIsExceedingMaxOpenTrades,
              cancelOrder: mockCancelOrder,
              refreshOpenOrdersAndAccountInfo:
                mockRefreshOpenOrdersAndAccountInfo
            }));

            step = require('../handle-open-orders');

            rawData = {
              symbol: 'BTCUSDT',
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
              },
              symbolInfo: {
                quoteAsset: 'USDT'
              }
            };

            result = await step.execute(loggerMock, rawData);
          });

          it('triggers cancelOrder', () => {
            expect(mockCancelOrder).toHaveBeenCalledWith(
              loggerMock,
              'BTCUSDT',
              {
                orderId: 46838,
                price: '1799.58000000',
                side: 'BUY',
                stopPrice: '1800.1000',
                symbol: 'BTCUSDT',
                type: 'STOP_LOSS_LIMIT'
              }
            );
          });

          it('triggers refreshOpenOrdersAndAccountInfo', () => {
            expect(mockRefreshOpenOrdersAndAccountInfo).toHaveBeenCalledWith(
              loggerMock,
              'BTCUSDT'
            );
          });

          it('does not trigger slack.sendMessage', () => {
            expect(slackMock.sendMessage).not.toHaveBeenCalled();
          });

          it('does not trigger getAccountInfoFromAPI', () => {
            expect(mockGetAccountInfoFromAPI).not.toHaveBeenCalled();
          });

          it('returns expected value', () => {
            expect(result).toStrictEqual({
              symbol: 'BTCUSDT',
              featureToggle: {
                notifyDebug: false
              },
              action: 'buy-order-checking',
              openOrders: [
                {
                  openOrders: 'retrieved'
                }
              ],
              buy: {
                limitPrice: 1800,
                openOrders: [
                  {
                    buyOpenOrders: 'retrived'
                  }
                ]
              },
              sell: { limitPrice: 1800, openOrders: [] },
              symbolInfo: {
                quoteAsset: 'USDT'
              },
              accountInfo: {
                accountInfo: 'updated'
              }
            });
          });
        });

        describe('when cancelling order is succeed', () => {
          beforeEach(async () => {
            jest.mock('../../../trailingTradeHelper/common', () => ({
              getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
              isExceedingMaxOpenTrades: mockIsExceedingMaxOpenTrades,
              cancelOrder: mockCancelOrder,
              refreshOpenOrdersAndAccountInfo:
                mockRefreshOpenOrdersAndAccountInfo
            }));

            step = require('../handle-open-orders');

            rawData = {
              symbol: 'BTCUSDT',
              action: 'not-determined',
              openOrders: [
                {
                  symbol: 'BTCUSDT',
                  orderId: 46838,
                  origQty: '0.00001',
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
                    origQty: '0.00001',
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
              },
              symbolInfo: {
                quoteAsset: 'USDT'
              },
              quoteAssetBalance: {
                free: 50,
                locked: 0.0179958
              }
            };

            result = await step.execute(loggerMock, rawData);
          });

          it('triggers cancelOrder', () => {
            expect(mockCancelOrder).toHaveBeenCalledWith(
              loggerMock,
              'BTCUSDT',
              {
                orderId: 46838,
                origQty: '0.00001',
                price: '1799.58000000',
                side: 'BUY',
                stopPrice: '1800.1000',
                symbol: 'BTCUSDT',
                type: 'STOP_LOSS_LIMIT'
              }
            );
          });

          it('does not trigger refreshOpenOrdersAndAccountInfo', () => {
            expect(mockRefreshOpenOrdersAndAccountInfo).not.toHaveBeenCalled();
          });

          it('triggers getAccountInfoFromAPI', () => {
            expect(mockGetAccountInfoFromAPI).toHaveBeenCalledWith(loggerMock);
          });

          it('returns expected value', () => {
            expect(result).toStrictEqual({
              symbol: 'BTCUSDT',
              action: 'buy-order-cancelled',
              openOrders: [
                {
                  symbol: 'BTCUSDT',
                  orderId: 46838,
                  origQty: '0.00001',
                  price: '1799.58000000',
                  stopPrice: '1800.1000',
                  type: 'STOP_LOSS_LIMIT',
                  side: 'BUY'
                }
              ],
              buy: { limitPrice: 1800, openOrders: [] },
              sell: { limitPrice: 1800, openOrders: [] },
              symbolInfo: {
                quoteAsset: 'USDT'
              },
              quoteAssetBalance: {
                free: 50,
                locked: 0.0179958
              },
              accountInfo: {
                account: 'updated'
              }
            });
          });
        });
      });

      describe('when the current price higher than buy order price', () => {
        describe('when cancelling order is failed', () => {
          beforeEach(async () => {
            slackMock.sendMessage = jest.fn().mockResolvedValue(true);

            mockCancelOrder = jest.fn().mockResolvedValue(false);

            jest.mock('../../../trailingTradeHelper/common', () => ({
              getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
              isExceedingMaxOpenTrades: mockIsExceedingMaxOpenTrades,
              cancelOrder: mockCancelOrder,
              refreshOpenOrdersAndAccountInfo:
                mockRefreshOpenOrdersAndAccountInfo
            }));

            step = require('../handle-open-orders');

            rawData = {
              symbol: 'BTCUSDT',
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
                currentPrice: 1810,
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
                currentPrice: 1810,
                openOrders: []
              },
              symbolInfo: {
                quoteAsset: 'USDT'
              }
            };

            result = await step.execute(loggerMock, rawData);
          });

          it('triggers cancelOrder', () => {
            expect(mockCancelOrder).toHaveBeenCalledWith(
              loggerMock,
              'BTCUSDT',
              {
                orderId: 46838,
                price: '1799.58000000',
                side: 'BUY',
                stopPrice: '1800.1000',
                symbol: 'BTCUSDT',
                type: 'STOP_LOSS_LIMIT'
              }
            );
          });

          it('triggers refreshOpenOrdersAndAccountInfo', () => {
            expect(mockRefreshOpenOrdersAndAccountInfo).toHaveBeenCalledWith(
              loggerMock,
              'BTCUSDT'
            );
          });

          it('does not trigger slack.sendMessage', () => {
            expect(slackMock.sendMessage).not.toHaveBeenCalled();
          });

          it('does not trigger getAccountInfoFromAPI', () => {
            expect(mockGetAccountInfoFromAPI).not.toHaveBeenCalled();
          });

          it('returns expected value', () => {
            expect(result).toStrictEqual({
              symbol: 'BTCUSDT',
              featureToggle: {
                notifyDebug: false
              },
              action: 'buy-order-checking',
              openOrders: [
                {
                  openOrders: 'retrieved'
                }
              ],
              buy: {
                currentPrice: 1810,
                openOrders: [
                  {
                    buyOpenOrders: 'retrived'
                  }
                ]
              },
              sell: { currentPrice: 1810, openOrders: [] },
              symbolInfo: {
                quoteAsset: 'USDT'
              },
              accountInfo: {
                accountInfo: 'updated'
              }
            });
          });
        });

        describe('when cancelling order is succeed', () => {
          beforeEach(async () => {
            jest.mock('../../../trailingTradeHelper/common', () => ({
              getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
              isExceedingMaxOpenTrades: mockIsExceedingMaxOpenTrades,
              cancelOrder: mockCancelOrder,
              refreshOpenOrdersAndAccountInfo:
                mockRefreshOpenOrdersAndAccountInfo
            }));

            step = require('../handle-open-orders');

            rawData = {
              symbol: 'BTCUSDT',
              action: 'not-determined',
              openOrders: [
                {
                  symbol: 'BTCUSDT',
                  orderId: 46838,
                  origQty: '0.00001',
                  price: '1799.58000000',
                  stopPrice: '1800.1000',
                  type: 'STOP_LOSS_LIMIT',
                  side: 'BUY'
                }
              ],
              buy: {
                currentPrice: 1810,
                openOrders: [
                  {
                    symbol: 'BTCUSDT',
                    orderId: 46838,
                    origQty: '0.00001',
                    price: '1799.58000000',
                    stopPrice: '1800.1000',
                    type: 'STOP_LOSS_LIMIT',
                    side: 'BUY'
                  }
                ]
              },
              sell: {
                currentPrice: 1810,
                openOrders: []
              },
              symbolInfo: {
                quoteAsset: 'USDT'
              },
              quoteAssetBalance: {
                free: 50,
                locked: 0.0179958
              }
            };

            result = await step.execute(loggerMock, rawData);
          });

          it('triggers cancelOrder', () => {
            expect(mockCancelOrder).toHaveBeenCalledWith(
              loggerMock,
              'BTCUSDT',
              {
                orderId: 46838,
                origQty: '0.00001',
                price: '1799.58000000',
                side: 'BUY',
                stopPrice: '1800.1000',
                symbol: 'BTCUSDT',
                type: 'STOP_LOSS_LIMIT'
              }
            );
          });

          it('does not trigger refreshOpenOrdersAndAccountInfo', () => {
            expect(mockRefreshOpenOrdersAndAccountInfo).not.toHaveBeenCalled();
          });

          it('triggers getAccountInfoFromAPI', () => {
            expect(mockGetAccountInfoFromAPI).toHaveBeenCalledWith(loggerMock);
          });

          it('returns expected value', () => {
            expect(result).toStrictEqual({
              symbol: 'BTCUSDT',
              action: 'buy-order-cancelled',
              openOrders: [
                {
                  symbol: 'BTCUSDT',
                  orderId: 46838,
                  origQty: '0.00001',
                  price: '1799.58000000',
                  stopPrice: '1800.1000',
                  type: 'STOP_LOSS_LIMIT',
                  side: 'BUY'
                }
              ],
              buy: { currentPrice: 1810, openOrders: [] },
              sell: { currentPrice: 1810, openOrders: [] },
              symbolInfo: {
                quoteAsset: 'USDT'
              },
              quoteAssetBalance: {
                free: 50,
                locked: 0.0179958
              },
              accountInfo: {
                account: 'updated'
              }
            });
          });
        });
      });

      describe('when order trade limit is not reached and stop price is less than current limit price', () => {
        beforeEach(async () => {
          mockIsExceedingMaxOpenTrades = jest.fn().mockResolvedValue(false);

          jest.mock('../../../trailingTradeHelper/common', () => ({
            getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
            isExceedingMaxOpenTrades: mockIsExceedingMaxOpenTrades,
            cancelOrder: mockCancelOrder,
            refreshOpenOrdersAndAccountInfo: mockRefreshOpenOrdersAndAccountInfo
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
            },
            symbolInfo: {
              quoteAsset: 'USDT'
            }
          };

          result = await step.execute(loggerMock, rawData);
        });

        it('does not trigger cancelOrder', () => {
          expect(mockCancelOrder).not.toHaveBeenCalled();
        });

        it('does not trigger refreshOpenOrdersAndAccountInfo', () => {
          expect(mockRefreshOpenOrdersAndAccountInfo).not.toHaveBeenCalled();
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
            sell: { limitPrice: 1800, openOrders: [] },
            symbolInfo: {
              quoteAsset: 'USDT'
            }
          });
        });
      });
    });

    describe('when order is sell', () => {
      describe('when stop price is less than current limit price', () => {
        describe('when cancel order is failed', () => {
          beforeEach(async () => {
            slackMock.sendMessage = jest.fn().mockResolvedValue(true);

            mockCancelOrder = jest.fn().mockResolvedValue(false);

            jest.mock('../../../trailingTradeHelper/common', () => ({
              getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
              isExceedingMaxOpenTrades: mockIsExceedingMaxOpenTrades,
              cancelOrder: mockCancelOrder,
              refreshOpenOrdersAndAccountInfo:
                mockRefreshOpenOrdersAndAccountInfo
            }));
            step = require('../handle-open-orders');

            rawData = {
              symbol: 'BTCUSDT',
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
              },
              symbolInfo: {
                quoteAsset: 'USDT'
              }
            };

            result = await step.execute(loggerMock, rawData);
          });

          it('triggers cancelOrder', () => {
            expect(mockCancelOrder).toHaveBeenCalledWith(
              loggerMock,
              'BTCUSDT',
              {
                orderId: 46838,
                price: '1799.58000000',
                side: 'SELL',
                stopPrice: '1800.1000',
                symbol: 'BTCUSDT',
                type: 'STOP_LOSS_LIMIT'
              }
            );
          });

          it('triggers refreshOpenOrdersAndAccountInfo', () => {
            expect(mockRefreshOpenOrdersAndAccountInfo).toHaveBeenCalledWith(
              loggerMock,
              'BTCUSDT'
            );
          });

          it('does not trigger slack.sendMessage', () => {
            expect(slackMock.sendMessage).not.toHaveBeenCalled();
          });

          it('returns expected value', () => {
            expect(result).toStrictEqual({
              symbol: 'BTCUSDT',
              featureToggle: {
                notifyDebug: false
              },
              action: 'sell-order-checking',
              openOrders: [
                {
                  openOrders: 'retrieved'
                }
              ],
              buy: { limitPrice: 1800, openOrders: [] },
              sell: {
                limitPrice: 1801,
                openOrders: [
                  {
                    sellOpenOrders: 'retrived'
                  }
                ]
              },
              symbolInfo: {
                quoteAsset: 'USDT'
              },
              accountInfo: {
                accountInfo: 'updated'
              }
            });
          });
        });

        describe('when cancel order is succeed', () => {
          beforeEach(async () => {
            jest.mock('../../../trailingTradeHelper/common', () => ({
              getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
              isExceedingMaxOpenTrades: mockIsExceedingMaxOpenTrades,
              cancelOrder: mockCancelOrder,
              refreshOpenOrdersAndAccountInfo:
                mockRefreshOpenOrdersAndAccountInfo
            }));

            step = require('../handle-open-orders');

            rawData = {
              symbol: 'BTCUSDT',
              action: 'not-determined',
              openOrders: [
                {
                  symbol: 'BTCUSDT',
                  orderId: 46838,
                  origQty: '0.00001',
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
                    origQty: '0.00001',
                    price: '1799.58000000',
                    stopPrice: '1800.1000',
                    type: 'STOP_LOSS_LIMIT',
                    side: 'SELL'
                  }
                ]
              },
              symbolInfo: {
                baseAsset: 'BTC',
                quoteAsset: 'USDT'
              },
              baseAssetBalance: {
                free: 0,
                locked: 0.00001
              }
            };

            result = await step.execute(loggerMock, rawData);
          });

          it('triggers cancelOrder', () => {
            expect(mockCancelOrder).toHaveBeenCalledWith(
              loggerMock,
              'BTCUSDT',
              {
                orderId: 46838,
                origQty: '0.00001',
                price: '1799.58000000',
                side: 'SELL',
                stopPrice: '1800.1000',
                symbol: 'BTCUSDT',
                type: 'STOP_LOSS_LIMIT'
              }
            );
          });

          it('does not trigger refreshOpenOrdersAndAccountInfo', () => {
            expect(mockRefreshOpenOrdersAndAccountInfo).not.toHaveBeenCalled();
          });

          it('triggers getAccountInfoFromAPI', () => {
            expect(mockGetAccountInfoFromAPI).toHaveBeenCalledWith(loggerMock);
          });

          it('returns expected value', () => {
            expect(result).toStrictEqual({
              symbol: 'BTCUSDT',
              action: 'sell',
              openOrders: [
                {
                  symbol: 'BTCUSDT',
                  orderId: 46838,
                  origQty: '0.00001',
                  price: '1799.58000000',
                  stopPrice: '1800.1000',
                  type: 'STOP_LOSS_LIMIT',
                  side: 'SELL'
                }
              ],
              buy: { limitPrice: 1800, openOrders: [] },
              sell: { limitPrice: 1801, openOrders: [] },
              symbolInfo: {
                baseAsset: 'BTC',
                quoteAsset: 'USDT'
              },
              baseAssetBalance: {
                free: 0,
                locked: 0.00001
              },
              accountInfo: {
                account: 'updated'
              }
            });
          });
        });
      });

      describe('when the current price less than sell order price', () => {
        describe('when cancel order is failed', () => {
          beforeEach(async () => {
            slackMock.sendMessage = jest.fn().mockResolvedValue(true);

            mockCancelOrder = jest.fn().mockResolvedValue(false);

            jest.mock('../../../trailingTradeHelper/common', () => ({
              getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
              isExceedingMaxOpenTrades: mockIsExceedingMaxOpenTrades,
              cancelOrder: mockCancelOrder,
              refreshOpenOrdersAndAccountInfo:
                mockRefreshOpenOrdersAndAccountInfo
            }));
            step = require('../handle-open-orders');

            rawData = {
              symbol: 'BTCUSDT',
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
                currentPrice: 1799,
                openOrders: []
              },
              sell: {
                currentPrice: 1799,
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
              symbolInfo: {
                quoteAsset: 'USDT'
              }
            };

            result = await step.execute(loggerMock, rawData);
          });

          it('triggers cancelOrder', () => {
            expect(mockCancelOrder).toHaveBeenCalledWith(
              loggerMock,
              'BTCUSDT',
              {
                orderId: 46838,
                price: '1799.58000000',
                side: 'SELL',
                stopPrice: '1800.1000',
                symbol: 'BTCUSDT',
                type: 'STOP_LOSS_LIMIT'
              }
            );
          });

          it('triggers refreshOpenOrdersAndAccountInfo', () => {
            expect(mockRefreshOpenOrdersAndAccountInfo).toHaveBeenCalledWith(
              loggerMock,
              'BTCUSDT'
            );
          });

          it('does not trigger slack.sendMessage', () => {
            expect(slackMock.sendMessage).not.toHaveBeenCalled();
          });

          it('returns expected value', () => {
            expect(result).toStrictEqual({
              symbol: 'BTCUSDT',
              featureToggle: {
                notifyDebug: false
              },
              action: 'sell-order-checking',
              openOrders: [
                {
                  openOrders: 'retrieved'
                }
              ],
              buy: { currentPrice: 1799, openOrders: [] },
              sell: {
                currentPrice: 1799,
                openOrders: [
                  {
                    sellOpenOrders: 'retrived'
                  }
                ]
              },
              symbolInfo: {
                quoteAsset: 'USDT'
              },
              accountInfo: {
                accountInfo: 'updated'
              }
            });
          });
        });

        describe('when cancel order is succeed', () => {
          beforeEach(async () => {
            jest.mock('../../../trailingTradeHelper/common', () => ({
              getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
              isExceedingMaxOpenTrades: mockIsExceedingMaxOpenTrades,
              cancelOrder: mockCancelOrder,
              refreshOpenOrdersAndAccountInfo:
                mockRefreshOpenOrdersAndAccountInfo
            }));

            step = require('../handle-open-orders');

            rawData = {
              symbol: 'BTCUSDT',
              action: 'not-determined',
              openOrders: [
                {
                  symbol: 'BTCUSDT',
                  orderId: 46838,
                  origQty: '0.00001',
                  price: '1799.58000000',
                  stopPrice: '1800.1000',
                  type: 'STOP_LOSS_LIMIT',
                  side: 'SELL'
                }
              ],
              buy: {
                currentPrice: 1799,
                openOrders: []
              },
              sell: {
                currentPrice: 1799,
                openOrders: [
                  {
                    symbol: 'BTCUSDT',
                    orderId: 46838,
                    origQty: '0.00001',
                    price: '1799.58000000',
                    stopPrice: '1800.1000',
                    type: 'STOP_LOSS_LIMIT',
                    side: 'SELL'
                  }
                ]
              },
              symbolInfo: {
                baseAsset: 'BTC',
                quoteAsset: 'USDT'
              },
              baseAssetBalance: {
                free: 0,
                locked: 0.00001
              }
            };

            result = await step.execute(loggerMock, rawData);
          });

          it('triggers cancelOrder', () => {
            expect(mockCancelOrder).toHaveBeenCalledWith(
              loggerMock,
              'BTCUSDT',
              {
                orderId: 46838,
                origQty: '0.00001',
                price: '1799.58000000',
                side: 'SELL',
                stopPrice: '1800.1000',
                symbol: 'BTCUSDT',
                type: 'STOP_LOSS_LIMIT'
              }
            );
          });

          it('does not trigger refreshOpenOrdersAndAccountInfo', () => {
            expect(mockRefreshOpenOrdersAndAccountInfo).not.toHaveBeenCalled();
          });

          it('triggers getAccountInfoFromAPI', () => {
            expect(mockGetAccountInfoFromAPI).toHaveBeenCalledWith(loggerMock);
          });

          it('returns expected value', () => {
            expect(result).toStrictEqual({
              symbol: 'BTCUSDT',
              action: 'sell',
              openOrders: [
                {
                  symbol: 'BTCUSDT',
                  orderId: 46838,
                  origQty: '0.00001',
                  price: '1799.58000000',
                  stopPrice: '1800.1000',
                  type: 'STOP_LOSS_LIMIT',
                  side: 'SELL'
                }
              ],
              buy: { currentPrice: 1799, openOrders: [] },
              sell: { currentPrice: 1799, openOrders: [] },
              symbolInfo: {
                baseAsset: 'BTC',
                quoteAsset: 'USDT'
              },
              baseAssetBalance: {
                free: 0,
                locked: 0.00001
              },
              accountInfo: {
                account: 'updated'
              }
            });
          });
        });
      });

      describe('when stop price is more than current limit price', () => {
        beforeEach(async () => {
          jest.mock('../../../trailingTradeHelper/common', () => ({
            isExceedingMaxOpenTrades: mockIsExceedingMaxOpenTrades,
            cancelOrder: mockCancelOrder,
            refreshOpenOrdersAndAccountInfo: mockRefreshOpenOrdersAndAccountInfo
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
            },
            symbolInfo: {
              quoteAsset: 'USDT'
            }
          };

          result = await step.execute(loggerMock, rawData);
        });

        it('does not trigger cancelOrder', () => {
          expect(mockCancelOrder).not.toHaveBeenCalled();
        });

        it('does not trigger refreshOpenOrdersAndAccountInfo', () => {
          expect(mockRefreshOpenOrdersAndAccountInfo).not.toHaveBeenCalled();
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
            },
            symbolInfo: {
              quoteAsset: 'USDT'
            }
          });
        });
      });
    });
  });
});
