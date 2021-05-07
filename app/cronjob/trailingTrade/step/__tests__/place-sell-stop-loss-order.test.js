/* eslint-disable global-require */

describe('place-sell-stop-loss-order.js', () => {
  let result;
  let rawData;

  let binanceMock;
  let slackMock;
  let loggerMock;
  let cacheMock;

  let mockGetAndCacheOpenOrdersForSymbol;
  let mockGetAccountInfoFromAPI;

  describe('execute', () => {
    beforeEach(() => {
      jest.clearAllMocks().resetModules();
    });
    beforeEach(async () => {
      const { binance, slack, cache, logger } = require('../../../../helpers');

      binanceMock = binance;
      slackMock = slack;
      loggerMock = logger;
      cacheMock = cache;

      cacheMock.set = jest.fn().mockResolvedValue(true);
      slackMock.sendMessage = jest.fn().mockResolvedValue(true);
      binanceMock.client.order = jest.fn().mockResolvedValue(true);
    });

    describe('when symbol is locked', () => {
      beforeEach(async () => {
        mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([]);
        mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
          account: 'info'
        });

        jest.mock('../../../trailingTradeHelper/common', () => ({
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
          getAccountInfoFromAPI: mockGetAccountInfoFromAPI
        }));

        const step = require('../place-sell-stop-loss-order');

        rawData = {
          symbol: 'BTCUPUSDT',
          isLocked: true,
          symbolInfo: {
            filterLotSize: {
              stepSize: '0.01000000',
              minQty: '0.01000000',
              maxQty: '100.0000000'
            },
            filterPrice: { tickSize: '0.00100000' },
            filterMinNotional: { minNotional: '10.00000000' }
          },
          symbolConfiguration: {
            sell: {
              enabled: true,
              stopLoss: {
                orderType: 'market',
                disableBuyMinutes: 60
              }
            }
          },
          action: 'not-determined',
          baseAssetBalance: { free: 0.5 },
          sell: { currentPrice: 200, openOrders: [] }
        };

        result = await step.execute(loggerMock, rawData);
      });

      it('does not trigger binance.client.order', () => {
        expect(binanceMock.client.order).not.toHaveBeenCalled();
      });

      it('does not trigger getAndCacheOpenOrdersForSymbol', () => {
        expect(mockGetAndCacheOpenOrdersForSymbol).not.toHaveBeenCalled();
      });

      it('does not trigger getAccountInfoFromAPI', () => {
        expect(mockGetAccountInfoFromAPI).not.toHaveBeenCalled();
      });

      it('retruns expected value', () => {
        expect(result).toStrictEqual(rawData);
      });
    });

    describe('when action is not sell-stop-loss', () => {
      beforeEach(async () => {
        mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([]);
        mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
          account: 'info'
        });

        jest.mock('../../../trailingTradeHelper/common', () => ({
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
          getAccountInfoFromAPI: mockGetAccountInfoFromAPI
        }));

        const step = require('../place-sell-stop-loss-order');

        rawData = {
          symbol: 'BTCUPUSDT',
          isLocked: false,
          symbolInfo: {
            filterLotSize: {
              stepSize: '0.01000000',
              minQty: '0.01000000',
              maxQty: '100.0000000'
            },
            filterPrice: { tickSize: '0.00100000' },
            filterMinNotional: { minNotional: '10.00000000' }
          },
          symbolConfiguration: {
            sell: {
              enabled: true,
              stopLoss: {
                orderType: 'market',
                disableBuyMinutes: 60
              }
            }
          },
          action: 'not-determined',
          baseAssetBalance: { free: 0.5 },
          sell: { currentPrice: 200, openOrders: [] }
        };

        result = await step.execute(loggerMock, rawData);
      });

      it('does not trigger binance.client.order', () => {
        expect(binanceMock.client.order).not.toHaveBeenCalled();
      });

      it('does not trigger getAndCacheOpenOrdersForSymbol', () => {
        expect(mockGetAndCacheOpenOrdersForSymbol).not.toHaveBeenCalled();
      });

      it('does not trigger getAccountInfoFromAPI', () => {
        expect(mockGetAccountInfoFromAPI).not.toHaveBeenCalled();
      });

      it('retruns expected value', () => {
        expect(result).toStrictEqual(rawData);
      });
    });

    describe('when open orders exist', () => {
      beforeEach(async () => {
        mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([]);
        mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
          account: 'info'
        });

        jest.mock('../../../trailingTradeHelper/common', () => ({
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
          getAccountInfoFromAPI: mockGetAccountInfoFromAPI
        }));

        const step = require('../place-sell-stop-loss-order');

        rawData = {
          symbol: 'BTCUPUSDT',
          isLocked: false,
          symbolInfo: {
            filterLotSize: {
              stepSize: '0.01000000',
              minQty: '0.01000000',
              maxQty: '100.0000000'
            },
            filterPrice: { tickSize: '0.00100000' },
            filterMinNotional: { minNotional: '10.00000000' }
          },
          symbolConfiguration: {
            sell: {
              enabled: true,
              stopLoss: {
                orderType: 'market',
                disableBuyMinutes: 60
              }
            }
          },
          action: 'sell-stop-loss',
          baseAssetBalance: { free: 0.5 },
          sell: {
            currentPrice: 200,
            openOrders: [
              {
                orderId: 46838,
                type: 'STOP_LOSS_LIMIT',
                side: 'SELL',
                price: '199.000000',
                origQty: '0.5',
                stopPrice: '198.000000'
              }
            ]
          }
        };

        result = await step.execute(loggerMock, rawData);
      });

      it('does not trigger binance.client.order', () => {
        expect(binanceMock.client.order).not.toHaveBeenCalled();
      });

      it('does not trigger getAndCacheOpenOrdersForSymbol', () => {
        expect(mockGetAndCacheOpenOrdersForSymbol).not.toHaveBeenCalled();
      });

      it('does not trigger getAccountInfoFromAPI', () => {
        expect(mockGetAccountInfoFromAPI).not.toHaveBeenCalled();
      });

      it('retruns expected value', () => {
        expect(result).toStrictEqual({
          ...rawData,
          ...{
            sell: {
              currentPrice: 200,
              openOrders: [
                {
                  orderId: 46838,
                  type: 'STOP_LOSS_LIMIT',
                  side: 'SELL',
                  price: '199.000000',
                  origQty: '0.5',
                  stopPrice: '198.000000'
                }
              ],
              processMessage:
                'There are open orders for BTCUPUSDT. Do not place an order.',
              updatedAt: expect.any(Object)
            }
          }
        });
      });
    });

    describe('when quantity is not enough', () => {
      beforeEach(async () => {
        mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([]);
        mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
          account: 'info'
        });

        jest.mock('../../../trailingTradeHelper/common', () => ({
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
          getAccountInfoFromAPI: mockGetAccountInfoFromAPI
        }));

        const step = require('../place-sell-stop-loss-order');

        rawData = {
          symbol: 'BTCUPUSDT',
          isLocked: false,
          symbolInfo: {
            filterLotSize: {
              stepSize: '0.01000000',
              minQty: '0.01000000',
              maxQty: '100.0000000'
            },
            filterPrice: { tickSize: '0.00100000' },
            filterMinNotional: { minNotional: '10.00000000' }
          },
          symbolConfiguration: {
            sell: {
              enabled: true,
              stopLoss: {
                orderType: 'market',
                disableBuyMinutes: 60
              }
            }
          },
          action: 'sell-stop-loss',
          baseAssetBalance: { free: 0.01 },
          sell: {
            currentPrice: 200,
            openOrders: []
          }
        };

        result = await step.execute(loggerMock, rawData);
      });

      it('does not trigger binance.client.order', () => {
        expect(binanceMock.client.order).not.toHaveBeenCalled();
      });

      it('does not trigger getAndCacheOpenOrdersForSymbol', () => {
        expect(mockGetAndCacheOpenOrdersForSymbol).not.toHaveBeenCalled();
      });

      it('does not trigger getAccountInfoFromAPI', () => {
        expect(mockGetAccountInfoFromAPI).not.toHaveBeenCalled();
      });

      it('retruns expected value', () => {
        expect(result).toStrictEqual({
          ...rawData,
          ...{
            sell: {
              currentPrice: 200,
              openOrders: [],
              processMessage:
                `Order quantity is less or equal than the minimum quantity - 0.01000000.` +
                ` Do not place a stop-loss order.`,
              updatedAt: expect.any(Object)
            }
          }
        });
      });
    });

    describe('when order amount is less than minimum notional', () => {
      beforeEach(async () => {
        mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([]);
        mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
          account: 'info'
        });

        jest.mock('../../../trailingTradeHelper/common', () => ({
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
          getAccountInfoFromAPI: mockGetAccountInfoFromAPI
        }));

        const step = require('../place-sell-stop-loss-order');

        rawData = {
          symbol: 'BTCUPUSDT',
          isLocked: false,
          symbolInfo: {
            filterLotSize: {
              stepSize: '0.01000000',
              minQty: '0.01000000',
              maxQty: '100.0000000'
            },
            filterPrice: { tickSize: '0.00100000' },
            filterMinNotional: { minNotional: '10.00000000' }
          },
          symbolConfiguration: {
            sell: {
              enabled: true,
              stopLoss: {
                orderType: 'market',
                disableBuyMinutes: 60
              }
            }
          },
          action: 'sell-stop-loss',
          baseAssetBalance: { free: 0.05 },
          sell: {
            currentPrice: 200,
            openOrders: []
          }
        };

        result = await step.execute(loggerMock, rawData);
      });

      it('does not trigger binance.client.order', () => {
        expect(binanceMock.client.order).not.toHaveBeenCalled();
      });

      it('does not trigger getAndCacheOpenOrdersForSymbol', () => {
        expect(mockGetAndCacheOpenOrdersForSymbol).not.toHaveBeenCalled();
      });

      it('does not trigger getAccountInfoFromAPI', () => {
        expect(mockGetAccountInfoFromAPI).not.toHaveBeenCalled();
      });

      it('retruns expected value', () => {
        expect(result).toStrictEqual({
          ...rawData,
          ...{
            sell: {
              currentPrice: 200,
              openOrders: [],
              processMessage:
                'Notional value is less than the minimum notional value. Do not place a stop-loss order.',
              updatedAt: expect.any(Object)
            }
          }
        });
      });
    });

    describe('when trading is disabled', () => {
      beforeEach(async () => {
        mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([]);
        mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
          account: 'info'
        });

        jest.mock('../../../trailingTradeHelper/common', () => ({
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
          getAccountInfoFromAPI: mockGetAccountInfoFromAPI
        }));

        const step = require('../place-sell-stop-loss-order');

        rawData = {
          symbol: 'BTCUPUSDT',
          isLocked: false,
          symbolInfo: {
            filterLotSize: {
              stepSize: '0.01000000',
              minQty: '0.01000000',
              maxQty: '100.0000000'
            },
            filterPrice: { tickSize: '0.00100000' },
            filterMinNotional: { minNotional: '10.00000000' }
          },
          symbolConfiguration: {
            sell: {
              enabled: false,
              stopLoss: {
                orderType: 'market',
                disableBuyMinutes: 60
              }
            }
          },
          action: 'sell-stop-loss',
          baseAssetBalance: { free: 0.1 },
          sell: {
            currentPrice: 200,
            openOrders: []
          }
        };

        result = await step.execute(loggerMock, rawData);
      });

      it('does not trigger binance.client.order', () => {
        expect(binanceMock.client.order).not.toHaveBeenCalled();
      });

      it('does not trigger getAndCacheOpenOrdersForSymbol', () => {
        expect(mockGetAndCacheOpenOrdersForSymbol).not.toHaveBeenCalled();
      });

      it('does not trigger getAccountInfoFromAPI', () => {
        expect(mockGetAccountInfoFromAPI).not.toHaveBeenCalled();
      });

      it('retruns expected value', () => {
        expect(result).toStrictEqual({
          ...rawData,
          ...{
            sell: {
              currentPrice: 200,
              openOrders: [],
              processMessage:
                'Trading for BTCUPUSDT is disabled. Do not place a stop-loss order.',
              updatedAt: expect.any(Object)
            }
          }
        });
      });
    });

    describe('when stop loss order type is not market', () => {
      beforeEach(async () => {
        mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([]);
        mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
          account: 'info'
        });

        jest.mock('../../../trailingTradeHelper/common', () => ({
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
          getAccountInfoFromAPI: mockGetAccountInfoFromAPI
        }));

        const step = require('../place-sell-stop-loss-order');

        rawData = {
          symbol: 'BTCUPUSDT',
          isLocked: false,
          symbolInfo: {
            filterLotSize: {
              stepSize: '0.01000000',
              minQty: '0.01000000',
              maxQty: '100.0000000'
            },
            filterPrice: { tickSize: '0.00100000' },
            filterMinNotional: { minNotional: '10.00000000' }
          },
          symbolConfiguration: {
            sell: {
              enabled: true,
              stopLoss: {
                orderType: 'something',
                disableBuyMinutes: 60
              }
            }
          },
          action: 'sell-stop-loss',
          baseAssetBalance: { free: 0.1 },
          sell: {
            currentPrice: 200,
            openOrders: []
          }
        };

        result = await step.execute(loggerMock, rawData);
      });

      it('does not trigger binance.client.order', () => {
        expect(binanceMock.client.order).not.toHaveBeenCalled();
      });

      it('does not trigger getAndCacheOpenOrdersForSymbol', () => {
        expect(mockGetAndCacheOpenOrdersForSymbol).not.toHaveBeenCalled();
      });

      it('does not trigger getAccountInfoFromAPI', () => {
        expect(mockGetAccountInfoFromAPI).not.toHaveBeenCalled();
      });

      it('retruns expected value', () => {
        expect(result).toStrictEqual({
          ...rawData,
          ...{
            sell: {
              currentPrice: 200,
              openOrders: [],
              processMessage:
                'Unknown order type something. Do not place a stop-loss order.',
              updatedAt: expect.any(Object)
            }
          }
        });
      });
    });

    describe('when has enough amount to sell', () => {
      describe('when the quantity is more than maximum quantity', () => {
        beforeEach(async () => {
          mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([
            {
              orderId: 123,
              quantity: 100,
              side: 'sell',
              symbol: 'BTCUPUSDT',
              type: 'MARKET'
            }
          ]);
          mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
            account: 'info'
          });

          jest.mock('../../../trailingTradeHelper/common', () => ({
            getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
            getAccountInfoFromAPI: mockGetAccountInfoFromAPI
          }));

          const step = require('../place-sell-stop-loss-order');

          rawData = {
            symbol: 'BTCUPUSDT',
            isLocked: false,
            symbolInfo: {
              filterLotSize: {
                stepSize: '0.01000000',
                minQty: '0.01000000',
                maxQty: '100.0000000'
              },
              filterPrice: { tickSize: '0.00100000' },
              filterMinNotional: { minNotional: '10.00000000' }
            },
            symbolConfiguration: {
              sell: {
                enabled: true,
                stopLoss: {
                  orderType: 'market',
                  disableBuyMinutes: 60
                }
              }
            },
            action: 'sell-stop-loss',
            baseAssetBalance: { free: 200 },
            sell: {
              currentPrice: 200,
              openOrders: []
            }
          };

          result = await step.execute(loggerMock, rawData);
        });

        it('triggers binance.client.order', () => {
          expect(binanceMock.client.order).toHaveBeenCalledWith({
            symbol: 'BTCUPUSDT',
            side: 'sell',
            type: 'MARKET',
            quantity: 100
          });
        });

        it('triggers cache.set for disable buy order', () => {
          expect(cacheMock.set).toHaveBeenCalledWith(
            'BTCUPUSDT-disable-action-by-stop-loss',
            true,
            60 * 60
          );
        });

        it('triggers getAndCacheOpenOrdersForSymbol', () => {
          expect(mockGetAndCacheOpenOrdersForSymbol).toHaveBeenCalled();
        });

        it('triggers getAccountInfoFromAPI', () => {
          expect(mockGetAccountInfoFromAPI).toHaveBeenCalled();
        });

        it('retruns expected value', () => {
          expect(result).toStrictEqual({
            ...rawData,
            ...{
              openOrders: [
                {
                  orderId: 123,
                  quantity: 100,
                  side: 'sell',
                  symbol: 'BTCUPUSDT',
                  type: 'MARKET'
                }
              ],
              sell: {
                currentPrice: 200,
                openOrders: [
                  {
                    orderId: 123,
                    quantity: 100,
                    side: 'sell',
                    symbol: 'BTCUPUSDT',
                    type: 'MARKET'
                  }
                ],
                processMessage: 'Placed new market order for selling.',
                updatedAt: expect.any(Object)
              }
            }
          });
        });
      });

      describe('when the quality is less than maximum quantity', () => {
        beforeEach(async () => {
          mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([
            {
              orderId: 123,
              quantity: 0.09,
              side: 'sell',
              symbol: 'BTCUPUSDT',
              type: 'MARKET'
            }
          ]);
          mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
            account: 'info'
          });

          jest.mock('../../../trailingTradeHelper/common', () => ({
            getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
            getAccountInfoFromAPI: mockGetAccountInfoFromAPI
          }));

          const step = require('../place-sell-stop-loss-order');

          rawData = {
            symbol: 'BTCUPUSDT',
            isLocked: false,
            symbolInfo: {
              filterLotSize: {
                stepSize: '0.01000000',
                minQty: '0.01000000',
                maxQty: '100.0000000'
              },
              filterPrice: { tickSize: '0.00100000' },
              filterMinNotional: { minNotional: '10.00000000' }
            },
            symbolConfiguration: {
              sell: {
                enabled: true,
                stopLoss: {
                  orderType: 'market',
                  disableBuyMinutes: 60
                }
              }
            },
            action: 'sell-stop-loss',
            baseAssetBalance: { free: 0.1 },
            sell: {
              currentPrice: 200,
              openOrders: []
            }
          };

          result = await step.execute(loggerMock, rawData);
        });

        it('triggers binance.client.order', () => {
          expect(binanceMock.client.order).toHaveBeenCalledWith({
            quantity: 0.09,
            side: 'sell',
            symbol: 'BTCUPUSDT',
            type: 'MARKET'
          });
        });

        it('triggers cache.set for disable buy order', () => {
          expect(cacheMock.set).toHaveBeenCalledWith(
            'BTCUPUSDT-disable-action-by-stop-loss',
            true,
            60 * 60
          );
        });

        it('triggers getAndCacheOpenOrdersForSymbol', () => {
          expect(mockGetAndCacheOpenOrdersForSymbol).toHaveBeenCalled();
        });

        it('triggers getAccountInfoFromAPI', () => {
          expect(mockGetAccountInfoFromAPI).toHaveBeenCalled();
        });

        it('retruns expected value', () => {
          expect(result).toStrictEqual({
            ...rawData,
            ...{
              openOrders: [
                {
                  orderId: 123,
                  quantity: 0.09,
                  side: 'sell',
                  symbol: 'BTCUPUSDT',
                  type: 'MARKET'
                }
              ],
              sell: {
                currentPrice: 200,
                openOrders: [
                  {
                    orderId: 123,
                    quantity: 0.09,
                    side: 'sell',
                    symbol: 'BTCUPUSDT',
                    type: 'MARKET'
                  }
                ],
                processMessage: 'Placed new market order for selling.',
                updatedAt: expect.any(Object)
              }
            }
          });
        });
      });
    });
  });
});
