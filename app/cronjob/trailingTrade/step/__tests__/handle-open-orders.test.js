/* eslint-disable global-require */

describe('handle-open-orders.js', () => {
  let result;
  let rawData;
  let step;

  let binanceMock;
  let loggerMock;
  let slackMock;

  let mockGetAccountInfo;
  let mockGetAndCacheOpenOrdersForSymbol;
  let mockUpdateAccountInfo;
  let mockSaveOverrideAction;

  const accountInfoJSON = require('./fixtures/binance-account-info.json');

  describe('execute', () => {
    beforeEach(() => {
      jest.clearAllMocks().resetModules();

      const { binance, logger, slack } = require('../../../../helpers');
      binanceMock = binance;
      loggerMock = logger;
      slackMock = slack;

      mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([]);
      binanceMock.client.cancelOrder = jest.fn().mockResolvedValue(true);

      mockSaveOverrideAction = jest.fn().mockResolvedValue(true);
      mockUpdateAccountInfo = jest.fn().mockResolvedValue({
        account: 'updated'
      });
    });

    describe('when symbol is locked', () => {
      beforeEach(async () => {
        mockGetAccountInfo = jest.fn().mockResolvedValue(accountInfoJSON);

        jest.mock('../../../trailingTradeHelper/common', () => ({
          getAccountInfo: mockGetAccountInfo,
          updateAccountInfo: mockUpdateAccountInfo,
          saveOverrideAction: mockSaveOverrideAction,
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol
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
          },
          symbolInfo: {
            quoteAsset: 'USDT'
          }
        };

        result = await step.execute(loggerMock, rawData);
      });

      it('does not trigger cancelOrder', () => {
        expect(binanceMock.client.cancelOrder).not.toHaveBeenCalled();
      });

      it('does not trigger getAndCacheOpenOrdersForSymbol', () => {
        expect(mockGetAndCacheOpenOrdersForSymbol).not.toHaveBeenCalled();
      });

      it('does not trigger getAccountInfo', () => {
        expect(mockGetAccountInfo).not.toHaveBeenCalled();
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
          sell: { limitPrice: 1800, openOrders: [] },
          symbolInfo: {
            quoteAsset: 'USDT'
          }
        });
      });
    });

    describe('when action is not not-determined', () => {
      beforeEach(async () => {
        mockGetAccountInfo = jest.fn().mockResolvedValue(accountInfoJSON);

        mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([]);

        jest.mock('../../../trailingTradeHelper/common', () => ({
          getAccountInfo: mockGetAccountInfo,
          updateAccountInfo: mockUpdateAccountInfo,
          saveOverrideAction: mockSaveOverrideAction,
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol
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
          },
          symbolInfo: {
            quoteAsset: 'USDT'
          }
        };

        result = await step.execute(loggerMock, rawData);
      });

      it('does not trigger cancelOrder', () => {
        expect(binanceMock.client.cancelOrder).not.toHaveBeenCalled();
      });

      it('does not trigger getAndCacheOpenOrdersForSymbol', () => {
        expect(mockGetAndCacheOpenOrdersForSymbol).not.toHaveBeenCalled();
      });

      it('does not trigger getAccountInfo', () => {
        expect(mockGetAccountInfo).not.toHaveBeenCalled();
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
          sell: { limitPrice: 1800, openOrders: [] },
          symbolInfo: {
            quoteAsset: 'USDT'
          }
        });
      });
    });

    describe('when order is not STOP_LOSS_LIMIT', () => {
      beforeEach(async () => {
        mockGetAccountInfo = jest.fn().mockResolvedValue(accountInfoJSON);

        mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([]);

        jest.mock('../../../trailingTradeHelper/common', () => ({
          getAccountInfo: mockGetAccountInfo,
          updateAccountInfo: mockUpdateAccountInfo,
          saveOverrideAction: mockSaveOverrideAction,
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol
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
          },
          symbolInfo: {
            quoteAsset: 'USDT'
          }
        };

        result = await step.execute(loggerMock, rawData);
      });

      it('does not trigger cancelOrder', () => {
        expect(binanceMock.client.cancelOrder).not.toHaveBeenCalled();
      });

      it('does not trigger getAndCacheOpenOrdersForSymbol', () => {
        expect(mockGetAndCacheOpenOrdersForSymbol).not.toHaveBeenCalled();
      });

      it('does not trigger getAccountInfo', () => {
        expect(mockGetAccountInfo).not.toHaveBeenCalled();
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
          sell: { limitPrice: 1800, openOrders: [] },
          symbolInfo: {
            quoteAsset: 'USDT'
          }
        });
      });
    });

    describe('when order is buy', () => {
      describe('when stop price is higher or equal than current limit price', () => {
        describe('when cancelling order is failed', () => {
          beforeEach(() => {
            slackMock.sendMessage = jest.fn().mockResolvedValue(true);

            binanceMock.client.cancelOrder = jest
              .fn()
              .mockRejectedValue(new Error('something happened'));

            mockGetAccountInfo = jest.fn().mockResolvedValue(accountInfoJSON);

            jest.mock('../../../trailingTradeHelper/common', () => ({
              getAccountInfo: mockGetAccountInfo,
              updateAccountInfo: mockUpdateAccountInfo,
              saveOverrideAction: mockSaveOverrideAction,
              getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol
            }));
          });

          describe('when got getAndCacheOpenOrdersForSymbol successfully', () => {
            beforeEach(async () => {
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

              step = require('../handle-open-orders');

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
                },
                symbolInfo: {
                  quoteAsset: 'USDT'
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

            it('triggers getAccountInfo', () => {
              expect(mockGetAccountInfo).toHaveBeenCalledWith(loggerMock);
            });

            it('triggers getAndCacheOpenOrdersForSymbol', () => {
              expect(mockGetAndCacheOpenOrdersForSymbol).toHaveBeenCalledWith(
                loggerMock,
                'BTCUSDT'
              );
            });

            it('does not trigger slack.sendMessage', () => {
              expect(slackMock.sendMessage).not.toHaveBeenCalled();
            });

            it('triggers saveOverrideAction', () => {
              expect(mockSaveOverrideAction).toHaveBeenCalledWith(
                loggerMock,
                'BTCUSDT',
                {
                  action: 'buy',
                  actionAt: expect.any(String),
                  triggeredBy: 'buy-cancelled',
                  notify: false,
                  checkTradingView: true
                },
                'The bot will place a buy order in the next tick because could not retrieve the cancelled order result.'
              );
            });

            it('does not trigger updateAccountInfo', () => {
              expect(mockUpdateAccountInfo).not.toHaveBeenCalled();
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
                symbolInfo: {
                  quoteAsset: 'USDT'
                },
                accountInfo: accountInfoJSON
              });
            });
          });
        });

        describe('when cancelling order is succeed', () => {
          beforeEach(async () => {
            mockGetAccountInfo = jest.fn().mockResolvedValue(accountInfoJSON);

            mockGetAndCacheOpenOrdersForSymbol = jest
              .fn()
              .mockResolvedValue([]);

            jest.mock('../../../trailingTradeHelper/common', () => ({
              getAccountInfo: mockGetAccountInfo,
              updateAccountInfo: mockUpdateAccountInfo,
              saveOverrideAction: mockSaveOverrideAction,
              getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol
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
            expect(binanceMock.client.cancelOrder).toHaveBeenCalledWith({
              symbol: 'BTCUSDT',
              orderId: 46838
            });
          });

          it('does not trigger getAndCacheOpenOrdersForSymbol', () => {
            expect(mockGetAndCacheOpenOrdersForSymbol).not.toHaveBeenCalled();
          });

          it('does not trigger getAccountInfo', () => {
            expect(mockGetAccountInfo).not.toHaveBeenCalled();
          });

          it('triggers updateAccountInfo', () => {
            expect(mockUpdateAccountInfo).toHaveBeenCalledWith(
              loggerMock,
              [
                {
                  asset: 'USDT',
                  free: 50.0179958,
                  locked: 0
                }
              ],
              expect.any(String)
            );
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

      describe('when stop price is less than current limit price', () => {
        beforeEach(async () => {
          mockGetAccountInfo = jest.fn().mockResolvedValue(accountInfoJSON);
          mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([]);

          jest.mock('../../../trailingTradeHelper/common', () => ({
            getAccountInfo: mockGetAccountInfo,
            updateAccountInfo: mockUpdateAccountInfo,
            saveOverrideAction: mockSaveOverrideAction,
            getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol
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
            },
            symbolInfo: {
              quoteAsset: 'USDT'
            }
          };

          result = await step.execute(loggerMock, rawData);
        });

        it('does not trigger cancelOrder', () => {
          expect(binanceMock.client.cancelOrder).not.toHaveBeenCalled();
        });

        it('does not trigger getAndCacheOpenOrdersForSymbol', () => {
          expect(mockGetAndCacheOpenOrdersForSymbol).not.toHaveBeenCalled();
        });

        it('does not trigger getAccountInfo', () => {
          expect(mockGetAccountInfo).not.toHaveBeenCalled();
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
            sell: { limitPrice: 1800, openOrders: [] },
            symbolInfo: {
              quoteAsset: 'USDT'
            }
          });
        });
      });
    });

    describe('when order is sell', () => {
      describe('when stop price is less or equal than current limit price', () => {
        describe('when cancel order is failed', () => {
          beforeEach(() => {
            slackMock.sendMessage = jest.fn().mockResolvedValue(true);

            binanceMock.client.cancelOrder = jest
              .fn()
              .mockRejectedValue(new Error('something happened'));

            mockGetAccountInfo = jest.fn().mockResolvedValue(accountInfoJSON);

            jest.mock('../../../trailingTradeHelper/common', () => ({
              getAccountInfo: mockGetAccountInfo,
              updateAccountInfo: mockUpdateAccountInfo,
              saveOverrideAction: mockSaveOverrideAction,
              getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol
            }));
          });

          describe('when got getAndCacheOpenOrdersForSymbol successfully', () => {
            beforeEach(async () => {
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

              step = require('../handle-open-orders');

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
                },
                symbolInfo: {
                  quoteAsset: 'USDT'
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
              expect(mockGetAndCacheOpenOrdersForSymbol).toHaveBeenCalledWith(
                loggerMock,
                'BTCUSDT'
              );
            });

            it('triggers getAccountInfo', () => {
              expect(mockGetAccountInfo).toHaveBeenCalled();
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
                symbolInfo: {
                  quoteAsset: 'USDT'
                },
                accountInfo: accountInfoJSON
              });
            });
          });
        });

        describe('when cancel order is succeed', () => {
          beforeEach(async () => {
            mockGetAndCacheOpenOrdersForSymbol = jest
              .fn()
              .mockResolvedValue([]);

            mockGetAccountInfo = jest.fn().mockResolvedValue(accountInfoJSON);

            jest.mock('../../../trailingTradeHelper/common', () => ({
              getAccountInfo: mockGetAccountInfo,
              updateAccountInfo: mockUpdateAccountInfo,
              saveOverrideAction: mockSaveOverrideAction,
              getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol
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
            expect(binanceMock.client.cancelOrder).toHaveBeenCalledWith({
              symbol: 'BTCUSDT',
              orderId: 46838
            });
          });

          it('does not trigger getAndCacheOpenOrdersForSymbol', () => {
            expect(mockGetAndCacheOpenOrdersForSymbol).not.toHaveBeenCalled();
          });

          it('does not trigger getAccountInfo', () => {
            expect(mockGetAccountInfo).not.toHaveBeenCalled();
          });

          it('triggers updateAccountInfo', () => {
            expect(mockUpdateAccountInfo).toHaveBeenCalledWith(
              loggerMock,
              [
                {
                  asset: 'BTC',
                  free: 0.00001,
                  locked: 0
                }
              ],
              expect.any(String)
            );
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

      describe('when stop price is more than current limit price', () => {
        beforeEach(async () => {
          mockGetAccountInfo = jest.fn().mockResolvedValue(accountInfoJSON);

          jest.mock('../../../trailingTradeHelper/common', () => ({
            getAccountInfo: mockGetAccountInfo,
            saveOverrideAction: mockSaveOverrideAction,
            getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol
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
            },
            symbolInfo: {
              quoteAsset: 'USDT'
            }
          };

          result = await step.execute(loggerMock, rawData);
        });

        it('does not trigger cancelOrder', () => {
          expect(binanceMock.client.cancelOrder).not.toHaveBeenCalled();
        });

        it('does not trigger getAccountInfo', () => {
          expect(mockGetAccountInfo).not.toHaveBeenCalled();
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
