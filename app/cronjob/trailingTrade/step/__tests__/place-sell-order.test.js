/* eslint-disable global-require */

describe('place-sell-order.js', () => {
  let result;
  let rawData;

  let binanceMock;
  let slackMock;
  let loggerMock;

  let mockGetAccountInfoFromAPI;
  let mockIsExceedAPILimit;
  let mockGetAPILimit;
  let mockGetAndCacheOpenOrdersForSymbol;

  let mockSaveGridTradeOrder;

  describe('execute', () => {
    beforeEach(() => {
      jest.clearAllMocks().resetModules();
    });

    beforeEach(async () => {
      const { binance, slack, logger } = require('../../../../helpers');

      binanceMock = binance;
      slackMock = slack;
      loggerMock = logger;

      slackMock.sendMessage = jest.fn().mockResolvedValue(true);
      binanceMock.client.order = jest.fn().mockResolvedValue(true);

      mockIsExceedAPILimit = jest.fn().mockReturnValue(false);
      mockGetAPILimit = jest.fn().mockResolvedValue(10);

      mockSaveGridTradeOrder = jest.fn().mockResolvedValue(true);

      mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([]);
    });

    describe('when action is not sell', () => {
      beforeEach(async () => {
        mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
          account: 'info'
        });

        jest.mock('../../../trailingTradeHelper/common', () => ({
          getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
          isExceedAPILimit: mockIsExceedAPILimit,
          getAPILimit: mockGetAPILimit,
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol
        }));

        jest.mock('../../../trailingTradeHelper/order', () => ({
          saveGridTradeOrder: mockSaveGridTradeOrder
        }));

        const step = require('../place-sell-order');

        rawData = {
          symbol: 'BTCUPUSDT',
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
              currentGridTradeIndex: 0,
              currentGridTrade: {
                triggerPercentage: 1.03,
                stopPercentage: 0.985,
                limitPercentage: 0.984,
                quantityPercentage: 0.8,
                executed: false,
                executedOrder: null
              }
            },
            system: {
              checkOrderExecutePeriod: 10
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
        mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
          account: 'info'
        });

        jest.mock('../../../trailingTradeHelper/common', () => ({
          getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
          isExceedAPILimit: mockIsExceedAPILimit,
          getAPILimit: mockGetAPILimit,
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol
        }));

        jest.mock('../../../trailingTradeHelper/order', () => ({
          saveGridTradeOrder: mockSaveGridTradeOrder
        }));

        const step = require('../place-sell-order');

        rawData = {
          symbol: 'BTCUPUSDT',
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
              currentGridTradeIndex: 0,
              currentGridTrade: {
                triggerPercentage: 1.03,
                stopPercentage: 0.985,
                limitPercentage: 0.984,
                quantityPercentage: 0.8,
                executed: false,
                executedOrder: null
              }
            },
            system: {
              checkOrderExecutePeriod: 10
            }
          },
          action: 'sell',
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
                'There are open orders for BTCUPUSDT. Do not place an order for the grid trade #1.',
              updatedAt: expect.any(Object)
            }
          }
        });
      });
    });

    describe('when current grid trade is null', () => {
      beforeEach(async () => {
        mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
          account: 'info'
        });

        jest.mock('../../../trailingTradeHelper/common', () => ({
          getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
          isExceedAPILimit: mockIsExceedAPILimit,
          getAPILimit: mockGetAPILimit,
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol
        }));

        jest.mock('../../../trailingTradeHelper/order', () => ({
          saveGridTradeOrder: mockSaveGridTradeOrder
        }));

        const step = require('../place-sell-order');

        rawData = {
          symbol: 'BTCUPUSDT',
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
              currentGridTradeIndex: -1,
              currentGridTrade: null
            },
            system: {
              checkOrderExecutePeriod: 10
            }
          },
          action: 'sell',
          baseAssetBalance: { free: 0.5 },
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
                'Current grid trade is not defined. Do not place an order.',
              updatedAt: expect.any(Object)
            }
          }
        });
      });
    });

    describe('when quantity is not enough', () => {
      describe('BTCUPUSDT', () => {
        beforeEach(async () => {
          mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
            account: 'info'
          });

          jest.mock('../../../trailingTradeHelper/common', () => ({
            getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
            isExceedAPILimit: mockIsExceedAPILimit,
            getAPILimit: mockGetAPILimit,
            getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol
          }));

          jest.mock('../../../trailingTradeHelper/order', () => ({
            saveGridTradeOrder: mockSaveGridTradeOrder
          }));

          const step = require('../place-sell-order');

          rawData = {
            symbol: 'BTCUPUSDT',
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
                currentGridTradeIndex: 0,
                currentGridTrade: {
                  triggerPercentage: 1.03,
                  stopPercentage: 0.985,
                  limitPercentage: 0.984,
                  quantityPercentage: 0.8,
                  executed: false,
                  executedOrder: null
                }
              },
              system: {
                checkOrderExecutePeriod: 10
              }
            },
            action: 'sell',
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

        it('does not trigger saveGridTradeOrder', () => {
          expect(mockSaveGridTradeOrder).not.toHaveBeenCalled();
        });

        it('retruns expected value', () => {
          expect(result).toStrictEqual({
            ...rawData,
            ...{
              sell: {
                currentPrice: 200,
                openOrders: [],
                processMessage:
                  `Order quantity is less or equal than the minimum quantity - 0.01000000. ` +
                  `Do not place an order for the grid trade #1.`,
                updatedAt: expect.any(Object)
              }
            }
          });
        });
      });

      describe('ALPHABTC', () => {
        beforeEach(async () => {
          mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
            account: 'info'
          });

          jest.mock('../../../trailingTradeHelper/common', () => ({
            getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
            isExceedAPILimit: mockIsExceedAPILimit,
            getAPILimit: mockGetAPILimit,
            getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol
          }));

          jest.mock('../../../trailingTradeHelper/order', () => ({
            saveGridTradeOrder: mockSaveGridTradeOrder
          }));

          const step = require('../place-sell-order');

          rawData = {
            symbol: 'ALPHABTC',
            symbolInfo: {
              filterLotSize: {
                stepSize: '1.00000000',
                minQty: '1.00000000',
                maxQty: '90000000.00000000'
              },
              filterPrice: { tickSize: '0.00000001' },
              filterMinNotional: { minNotional: '0.00010000' }
            },
            symbolConfiguration: {
              sell: {
                enabled: true,
                currentGridTradeIndex: 0,
                currentGridTrade: {
                  triggerPercentage: 1.03,
                  stopPercentage: 0.99,
                  limitPercentage: 0.989,
                  quantityPercentage: 0.8,
                  executed: false,
                  executedOrder: null
                }
              },
              system: {
                checkOrderExecutePeriod: 10
              }
            },
            action: 'sell',
            baseAssetBalance: { free: 1 },
            sell: {
              currentPrice: 0.00003771,
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

        it('does not trigger saveGridTradeOrder', () => {
          expect(mockSaveGridTradeOrder).not.toHaveBeenCalled();
        });

        it('retruns expected value', () => {
          expect(result).toStrictEqual({
            ...rawData,
            ...{
              sell: {
                currentPrice: 0.00003771,
                openOrders: [],
                processMessage:
                  `Order quantity is less or equal than the minimum quantity - 1.00000000. ` +
                  `Do not place an order for the grid trade #1.`,
                updatedAt: expect.any(Object)
              }
            }
          });
        });
      });

      describe('BTCBRL', () => {
        beforeEach(async () => {
          mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
            account: 'info'
          });

          jest.mock('../../../trailingTradeHelper/common', () => ({
            getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
            isExceedAPILimit: mockIsExceedAPILimit,
            getAPILimit: mockGetAPILimit,
            getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol
          }));

          jest.mock('../../../trailingTradeHelper/order', () => ({
            saveGridTradeOrder: mockSaveGridTradeOrder
          }));

          const step = require('../place-sell-order');

          rawData = {
            symbol: 'BTCBRL',
            symbolInfo: {
              filterLotSize: {
                minQty: '0.00000100',
                maxQty: '9000.00000000',
                stepSize: '0.00000100'
              },
              filterPrice: { tickSize: '1.00000000' },
              filterMinNotional: { minNotional: '10.00000000' }
            },
            symbolConfiguration: {
              sell: {
                enabled: true,
                currentGridTradeIndex: 0,
                currentGridTrade: {
                  triggerPercentage: 1.03,
                  stopPercentage: 0.99,
                  limitPercentage: 0.989,
                  quantityPercentage: 0.8,
                  executed: false,
                  executedOrder: null
                }
              },
              system: {
                checkOrderExecutePeriod: 10
              }
            },
            action: 'sell',
            baseAssetBalance: { free: 0.000001 },
            sell: {
              currentPrice: 268748,
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

        it('does not trigger saveGridTradeOrder', () => {
          expect(mockSaveGridTradeOrder).not.toHaveBeenCalled();
        });

        it('retruns expected value', () => {
          expect(result).toStrictEqual({
            ...rawData,
            ...{
              sell: {
                currentPrice: 268748,
                openOrders: [],
                processMessage:
                  `Order quantity is less or equal than the minimum quantity - 0.00000100. ` +
                  `Do not place an order for the grid trade #1.`,
                updatedAt: expect.any(Object)
              }
            }
          });
        });
      });
    });

    describe('when order amount is less than minimum notional', () => {
      describe('BTCUPUSDT', () => {
        beforeEach(async () => {
          mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
            account: 'info'
          });

          jest.mock('../../../trailingTradeHelper/common', () => ({
            getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
            isExceedAPILimit: mockIsExceedAPILimit,
            getAPILimit: mockGetAPILimit,
            getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol
          }));

          jest.mock('../../../trailingTradeHelper/order', () => ({
            saveGridTradeOrder: mockSaveGridTradeOrder
          }));

          const step = require('../place-sell-order');

          rawData = {
            symbol: 'BTCUPUSDT',
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
                currentGridTradeIndex: 0,
                currentGridTrade: {
                  triggerPercentage: 1.03,
                  stopPercentage: 0.99,
                  limitPercentage: 0.989,
                  quantityPercentage: 1,
                  executed: false,
                  executedOrder: null
                }
              },
              system: {
                checkOrderExecutePeriod: 10
              }
            },
            action: 'sell',
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

        it('does not trigger saveGridTradeOrder', () => {
          expect(mockSaveGridTradeOrder).not.toHaveBeenCalled();
        });

        it('retruns expected value', () => {
          expect(result).toStrictEqual({
            ...rawData,
            ...{
              sell: {
                currentPrice: 200,
                openOrders: [],
                processMessage:
                  `Notional value is less than the minimum notional value. ` +
                  `Do not place an order for the grid trade #1.`,
                updatedAt: expect.any(Object)
              }
            }
          });
        });
      });

      describe('ALPHBTC', () => {
        beforeEach(async () => {
          mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
            account: 'info'
          });

          jest.mock('../../../trailingTradeHelper/common', () => ({
            getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
            isExceedAPILimit: mockIsExceedAPILimit,
            getAPILimit: mockGetAPILimit,
            getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol
          }));

          jest.mock('../../../trailingTradeHelper/order', () => ({
            saveGridTradeOrder: mockSaveGridTradeOrder
          }));

          const step = require('../place-sell-order');

          rawData = {
            symbol: 'ALPHABTC',
            symbolInfo: {
              filterLotSize: {
                minQty: '1.00000000',
                maxQty: '90000000.00000000',
                stepSize: '1.00000000'
              },
              filterPrice: { tickSize: '0.00000001' },
              filterMinNotional: { minNotional: '0.00010000' }
            },
            symbolConfiguration: {
              sell: {
                enabled: true,
                currentGridTradeIndex: 0,
                currentGridTrade: {
                  triggerPercentage: 1.03,
                  stopPercentage: 0.99,
                  limitPercentage: 0.989,
                  quantityPercentage: 1,
                  executed: false,
                  executedOrder: null
                }
              },
              system: {
                checkOrderExecutePeriod: 10
              }
            },
            action: 'sell',
            baseAssetBalance: { free: 3 },
            sell: {
              currentPrice: 0.00003771,
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

        it('does not trigger saveGridTradeOrder', () => {
          expect(mockSaveGridTradeOrder).not.toHaveBeenCalled();
        });

        it('retruns expected value', () => {
          expect(result).toStrictEqual({
            ...rawData,
            ...{
              sell: {
                currentPrice: 0.00003771,
                openOrders: [],
                processMessage:
                  `Notional value is less than the minimum notional value. ` +
                  `Do not place an order for the grid trade #1.`,
                updatedAt: expect.any(Object)
              }
            }
          });
        });
      });

      describe('BTCBRL', () => {
        beforeEach(async () => {
          mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
            account: 'info'
          });

          jest.mock('../../../trailingTradeHelper/common', () => ({
            getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
            isExceedAPILimit: mockIsExceedAPILimit,
            getAPILimit: mockGetAPILimit,
            getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol
          }));

          jest.mock('../../../trailingTradeHelper/order', () => ({
            saveGridTradeOrder: mockSaveGridTradeOrder
          }));

          const step = require('../place-sell-order');

          rawData = {
            symbol: 'BTCBRL',
            symbolInfo: {
              filterLotSize: {
                minQty: '0.00000100',
                maxQty: '9000.00000000',
                stepSize: '0.00000100'
              },
              filterPrice: { tickSize: '1.00000000' },
              filterMinNotional: { minNotional: '10.00000000' }
            },
            symbolConfiguration: {
              sell: {
                enabled: true,
                currentGridTradeIndex: 0,
                currentGridTrade: {
                  triggerPercentage: 1.03,
                  stopPercentage: 0.99,
                  limitPercentage: 0.989,
                  quantityPercentage: 1,
                  executed: false,
                  executedOrder: null
                }
              },
              system: {
                checkOrderExecutePeriod: 10
              }
            },
            action: 'sell',
            baseAssetBalance: { free: 0.00003 },
            sell: {
              currentPrice: 268748,
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

        it('does not trigger saveGridTradeOrder', () => {
          expect(mockSaveGridTradeOrder).not.toHaveBeenCalled();
        });

        it('retruns expected value', () => {
          expect(result).toStrictEqual({
            ...rawData,
            ...{
              sell: {
                currentPrice: 268748,
                openOrders: [],
                processMessage:
                  `Notional value is less than the minimum notional value. ` +
                  `Do not place an order for the grid trade #1.`,
                updatedAt: expect.any(Object)
              }
            }
          });
        });
      });
    });

    describe('when trading is disabled', () => {
      beforeEach(async () => {
        mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
          account: 'info'
        });

        jest.mock('../../../trailingTradeHelper/common', () => ({
          getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
          isExceedAPILimit: mockIsExceedAPILimit,
          getAPILimit: mockGetAPILimit,
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol
        }));

        jest.mock('../../../trailingTradeHelper/order', () => ({
          saveGridTradeOrder: mockSaveGridTradeOrder
        }));

        const step = require('../place-sell-order');

        rawData = {
          symbol: 'BTCUPUSDT',
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
              currentGridTradeIndex: 0,
              currentGridTrade: {
                triggerPercentage: 1.03,
                stopPercentage: 0.99,
                limitPercentage: 0.989,
                quantityPercentage: 1,
                executed: false,
                executedOrder: null
              }
            },
            system: {
              checkOrderExecutePeriod: 10
            }
          },
          action: 'sell',
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

      it('does not trigger saveGridTradeOrder', () => {
        expect(mockSaveGridTradeOrder).not.toHaveBeenCalled();
      });

      it('retruns expected value', () => {
        expect(result).toStrictEqual({
          ...rawData,
          ...{
            sell: {
              currentPrice: 200,
              openOrders: [],
              processMessage:
                'Trading for BTCUPUSDT is disabled. Do not place an order for the grid trade #1.',
              updatedAt: expect.any(Object)
            }
          }
        });
      });
    });

    describe('when API limit is exceeded', () => {
      beforeEach(async () => {
        mockIsExceedAPILimit = jest.fn().mockReturnValue(true);

        mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
          account: 'info'
        });

        jest.mock('../../../trailingTradeHelper/common', () => ({
          getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
          isExceedAPILimit: mockIsExceedAPILimit,
          getAPILimit: mockGetAPILimit,
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol
        }));

        jest.mock('../../../trailingTradeHelper/order', () => ({
          saveGridTradeOrder: mockSaveGridTradeOrder
        }));

        const step = require('../place-sell-order');

        rawData = {
          symbol: 'BTCUPUSDT',
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
              currentGridTradeIndex: 0,
              currentGridTrade: {
                triggerPercentage: 1.03,
                stopPercentage: 0.99,
                limitPercentage: 0.989,
                quantityPercentage: 1,
                executed: false,
                executedOrder: null
              }
            },
            system: {
              checkOrderExecutePeriod: 10
            }
          },
          action: 'sell',
          baseAssetBalance: { free: 200 },
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

      it('does not trigger saveGridTradeOrder', () => {
        expect(mockSaveGridTradeOrder).not.toHaveBeenCalled();
      });

      it('retruns expected value', () => {
        expect(result).toStrictEqual({
          ...rawData,
          ...{
            sell: {
              currentPrice: 200,
              openOrders: [],
              processMessage:
                'Binance API limit has been exceeded. Do not place an order for the grid trade #1.',
              updatedAt: expect.any(Object)
            }
          }
        });
      });
    });

    describe('when has enough amount to sell', () => {
      describe('when the quantity is more than maximum quantity', () => {
        describe('BTCUPUSDT', () => {
          beforeEach(async () => {
            mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([
              {
                orderId: 123,
                price: 197.8,
                quantity: 100,
                side: 'sell',
                stopPrice: 198,
                symbol: 'BTCUPUSDT',
                timeInForce: 'GTC',
                type: 'STOP_LOSS_LIMIT'
              }
            ]);
            binanceMock.client.order = jest.fn().mockResolvedValue({
              symbol: 'BTCUPUSDT',
              orderId: 2701762317,
              orderListId: -1,
              clientOrderId: '6eGYHaJbmJrIS40eoq8ziM',
              transactTime: 1626946722520
            });

            mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
              account: 'info'
            });

            jest.mock('../../../trailingTradeHelper/common', () => ({
              getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
              isExceedAPILimit: mockIsExceedAPILimit,
              getAPILimit: mockGetAPILimit,
              getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol
            }));

            jest.mock('../../../trailingTradeHelper/order', () => ({
              saveGridTradeOrder: mockSaveGridTradeOrder
            }));

            const step = require('../place-sell-order');

            rawData = {
              symbol: 'BTCUPUSDT',
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
                  currentGridTradeIndex: 0,
                  currentGridTrade: {
                    triggerPercentage: 1.03,
                    stopPercentage: 0.99,
                    limitPercentage: 0.989,
                    quantityPercentage: 1,
                    executed: false,
                    executedOrder: null
                  }
                },
                system: {
                  checkOrderExecutePeriod: 10
                }
              },
              action: 'sell',
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
              price: 197.8,
              quantity: 100,
              side: 'sell',
              stopPrice: 198,
              symbol: 'BTCUPUSDT',
              timeInForce: 'GTC',
              type: 'STOP_LOSS_LIMIT'
            });
          });

          it('triggers saveGridTradeOrder for grid trade last sell order', () => {
            expect(mockSaveGridTradeOrder).toHaveBeenCalledWith(
              loggerMock,
              `BTCUPUSDT-grid-trade-last-sell-order`,
              {
                symbol: 'BTCUPUSDT',
                orderId: 2701762317,
                orderListId: -1,
                clientOrderId: '6eGYHaJbmJrIS40eoq8ziM',
                transactTime: 1626946722520,
                currentGridTradeIndex: 0
              }
            );
          });

          it('triggers getAndCacheOpenOrdersForSymbol', () => {
            expect(mockGetAndCacheOpenOrdersForSymbol).toHaveBeenCalledWith(
              loggerMock,
              'BTCUPUSDT'
            );
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
                    price: 197.8,
                    quantity: 100,
                    side: 'sell',
                    stopPrice: 198,
                    symbol: 'BTCUPUSDT',
                    timeInForce: 'GTC',
                    type: 'STOP_LOSS_LIMIT'
                  }
                ],
                sell: {
                  currentPrice: 200,
                  openOrders: [
                    {
                      orderId: 123,
                      price: 197.8,
                      quantity: 100,
                      side: 'sell',
                      stopPrice: 198,
                      symbol: 'BTCUPUSDT',
                      timeInForce: 'GTC',
                      type: 'STOP_LOSS_LIMIT'
                    }
                  ],
                  processMessage:
                    'Placed new stop loss limit order for selling of grid trade #1.',
                  updatedAt: expect.any(Object)
                }
              }
            });
          });
        });

        describe('ALPHABTC', () => {
          beforeEach(async () => {
            mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([
              {
                orderId: 123,
                price: 0.00003729,
                quantity: 90000000,
                side: 'sell',
                stopPrice: 0.00003733,
                symbol: 'ALPHABTC',
                timeInForce: 'GTC',
                type: 'STOP_LOSS_LIMIT'
              }
            ]);
            binanceMock.client.order = jest.fn().mockResolvedValue({
              symbol: 'ALPHABTC',
              orderId: 2701762317,
              orderListId: -1,
              clientOrderId: '6eGYHaJbmJrIS40eoq8ziM',
              transactTime: 1626946722520
            });

            mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
              account: 'info'
            });

            jest.mock('../../../trailingTradeHelper/common', () => ({
              getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
              isExceedAPILimit: mockIsExceedAPILimit,
              getAPILimit: mockGetAPILimit,
              getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol
            }));

            jest.mock('../../../trailingTradeHelper/order', () => ({
              saveGridTradeOrder: mockSaveGridTradeOrder
            }));

            const step = require('../place-sell-order');

            rawData = {
              symbol: 'ALPHABTC',
              symbolInfo: {
                filterLotSize: {
                  minQty: '1.00000000',
                  maxQty: '90000000.00000000',
                  stepSize: '1.00000000'
                },
                filterPrice: { tickSize: '0.00000001' },
                filterMinNotional: { minNotional: '0.00010000' }
              },
              symbolConfiguration: {
                sell: {
                  enabled: true,
                  currentGridTradeIndex: 0,
                  currentGridTrade: {
                    triggerPercentage: 1.03,
                    stopPercentage: 0.99,
                    limitPercentage: 0.989,
                    quantityPercentage: 1,
                    executed: false,
                    executedOrder: null
                  }
                },
                system: {
                  checkOrderExecutePeriod: 10
                }
              },
              action: 'sell',
              baseAssetBalance: { free: 99000001 },
              sell: {
                currentPrice: 0.00003771,
                openOrders: []
              }
            };

            result = await step.execute(loggerMock, rawData);
          });

          it('triggers binance.client.order', () => {
            expect(binanceMock.client.order).toHaveBeenCalledWith({
              price: 0.00003729,
              quantity: 90000000,
              side: 'sell',
              stopPrice: 0.00003733,
              symbol: 'ALPHABTC',
              timeInForce: 'GTC',
              type: 'STOP_LOSS_LIMIT'
            });
          });

          it('triggers saveGridTradeOrder for grid trade last sell order', () => {
            expect(mockSaveGridTradeOrder).toHaveBeenCalledWith(
              loggerMock,
              'ALPHABTC-grid-trade-last-sell-order',
              {
                symbol: 'ALPHABTC',
                orderId: 2701762317,
                orderListId: -1,
                clientOrderId: '6eGYHaJbmJrIS40eoq8ziM',
                transactTime: 1626946722520,
                currentGridTradeIndex: 0
              }
            );
          });

          it('triggers getAndCacheOpenOrdersForSymbol', () => {
            expect(mockGetAndCacheOpenOrdersForSymbol).toHaveBeenCalledWith(
              loggerMock,
              'ALPHABTC'
            );
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
                    price: 0.00003729,
                    quantity: 90000000,
                    side: 'sell',
                    stopPrice: 0.00003733,
                    symbol: 'ALPHABTC',
                    timeInForce: 'GTC',
                    type: 'STOP_LOSS_LIMIT'
                  }
                ],
                sell: {
                  currentPrice: 0.00003771,
                  openOrders: [
                    {
                      orderId: 123,
                      price: 0.00003729,
                      quantity: 90000000,
                      side: 'sell',
                      stopPrice: 0.00003733,
                      symbol: 'ALPHABTC',
                      timeInForce: 'GTC',
                      type: 'STOP_LOSS_LIMIT'
                    }
                  ],
                  processMessage:
                    'Placed new stop loss limit order for selling of grid trade #1.',
                  updatedAt: expect.any(Object)
                }
              }
            });
          });
        });

        describe('BTCBRL', () => {
          beforeEach(async () => {
            mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([
              {
                orderId: 123,
                price: 265791,
                quantity: 9000,
                side: 'sell',
                stopPrice: 266060,
                symbol: 'BTCBRL',
                timeInForce: 'GTC',
                type: 'STOP_LOSS_LIMIT'
              }
            ]);
            binanceMock.client.order = jest.fn().mockResolvedValue({
              symbol: 'BTCBRL',
              orderId: 2701762317,
              orderListId: -1,
              clientOrderId: '6eGYHaJbmJrIS40eoq8ziM',
              transactTime: 1626946722520
            });

            mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
              account: 'info'
            });

            jest.mock('../../../trailingTradeHelper/common', () => ({
              getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
              isExceedAPILimit: mockIsExceedAPILimit,
              getAPILimit: mockGetAPILimit,
              getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol
            }));

            jest.mock('../../../trailingTradeHelper/order', () => ({
              saveGridTradeOrder: mockSaveGridTradeOrder
            }));

            const step = require('../place-sell-order');

            rawData = {
              symbol: 'BTCBRL',
              symbolInfo: {
                filterLotSize: {
                  minQty: '0.00000100',
                  maxQty: '9000.00000000',
                  stepSize: '0.00000100'
                },
                filterPrice: { tickSize: '1.00000000' },
                filterMinNotional: { minNotional: '10.00000000' }
              },
              symbolConfiguration: {
                sell: {
                  enabled: true,
                  currentGridTradeIndex: 0,
                  currentGridTrade: {
                    triggerPercentage: 1.03,
                    stopPercentage: 0.99,
                    limitPercentage: 0.989,
                    quantityPercentage: 1,
                    executed: false,
                    executedOrder: null
                  }
                },
                system: {
                  checkOrderExecutePeriod: 10
                }
              },
              action: 'sell',
              baseAssetBalance: { free: 10000 },
              sell: {
                currentPrice: 268748,
                openOrders: []
              }
            };

            result = await step.execute(loggerMock, rawData);
          });

          it('triggers binance.client.order', () => {
            expect(binanceMock.client.order).toHaveBeenCalledWith({
              price: 265791,
              quantity: 9000,
              side: 'sell',
              stopPrice: 266060,
              symbol: 'BTCBRL',
              timeInForce: 'GTC',
              type: 'STOP_LOSS_LIMIT'
            });
          });

          it('triggers saveGridTradeOrder for grid trade last sell order', () => {
            expect(mockSaveGridTradeOrder).toHaveBeenCalledWith(
              loggerMock,
              'BTCBRL-grid-trade-last-sell-order',
              {
                symbol: 'BTCBRL',
                orderId: 2701762317,
                orderListId: -1,
                clientOrderId: '6eGYHaJbmJrIS40eoq8ziM',
                transactTime: 1626946722520,
                currentGridTradeIndex: 0
              }
            );
          });

          it('triggers getAndCacheOpenOrdersForSymbol', () => {
            expect(mockGetAndCacheOpenOrdersForSymbol).toHaveBeenCalledWith(
              loggerMock,
              'BTCBRL'
            );
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
                    price: 265791,
                    quantity: 9000,
                    side: 'sell',
                    stopPrice: 266060,
                    symbol: 'BTCBRL',
                    timeInForce: 'GTC',
                    type: 'STOP_LOSS_LIMIT'
                  }
                ],
                sell: {
                  currentPrice: 268748,
                  openOrders: [
                    {
                      orderId: 123,
                      price: 265791,
                      quantity: 9000,
                      side: 'sell',
                      stopPrice: 266060,
                      symbol: 'BTCBRL',
                      timeInForce: 'GTC',
                      type: 'STOP_LOSS_LIMIT'
                    }
                  ],
                  processMessage:
                    'Placed new stop loss limit order for selling of grid trade #1.',
                  updatedAt: expect.any(Object)
                }
              }
            });
          });
        });
      });

      describe('when the quality is less than maximum quantity', () => {
        describe('when quantity percentage is less than 1', () => {
          describe('BTCUPUSDT', () => {
            beforeEach(async () => {
              mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([
                {
                  orderId: 123,
                  price: 197.8,
                  quantity: 0.49,
                  side: 'sell',
                  stopPrice: 198,
                  symbol: 'BTCUPUSDT',
                  timeInForce: 'GTC',
                  type: 'STOP_LOSS_LIMIT'
                }
              ]);
              binanceMock.client.order = jest.fn().mockResolvedValue({
                symbol: 'BTCUPUSDT',
                orderId: 2701762317,
                orderListId: -1,
                clientOrderId: '6eGYHaJbmJrIS40eoq8ziM',
                transactTime: 1626946722520
              });

              mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
                account: 'info'
              });

              jest.mock('../../../trailingTradeHelper/common', () => ({
                getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
                isExceedAPILimit: mockIsExceedAPILimit,
                getAPILimit: mockGetAPILimit,
                getAndCacheOpenOrdersForSymbol:
                  mockGetAndCacheOpenOrdersForSymbol
              }));

              jest.mock('../../../trailingTradeHelper/order', () => ({
                saveGridTradeOrder: mockSaveGridTradeOrder
              }));

              const step = require('../place-sell-order');

              rawData = {
                symbol: 'BTCUPUSDT',
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
                    currentGridTradeIndex: 0,
                    currentGridTrade: {
                      triggerPercentage: 1.03,
                      stopPercentage: 0.99,
                      limitPercentage: 0.989,
                      quantityPercentage: 0.5,
                      executed: false,
                      executedOrder: null
                    }
                  },
                  system: {
                    checkOrderExecutePeriod: 10
                  }
                },
                action: 'sell',
                baseAssetBalance: { free: 1 },
                sell: {
                  currentPrice: 200,
                  openOrders: []
                }
              };

              result = await step.execute(loggerMock, rawData);
            });

            it('triggers binance.client.order', () => {
              expect(binanceMock.client.order).toHaveBeenCalledWith({
                price: 197.8,
                quantity: 0.49,
                side: 'sell',
                stopPrice: 198,
                symbol: 'BTCUPUSDT',
                timeInForce: 'GTC',
                type: 'STOP_LOSS_LIMIT'
              });
            });

            it('triggers saveGridTradeOrder for grid trade last sell order', () => {
              expect(mockSaveGridTradeOrder).toHaveBeenCalledWith(
                loggerMock,
                'BTCUPUSDT-grid-trade-last-sell-order',
                {
                  symbol: 'BTCUPUSDT',
                  orderId: 2701762317,
                  orderListId: -1,
                  clientOrderId: '6eGYHaJbmJrIS40eoq8ziM',
                  transactTime: 1626946722520,
                  currentGridTradeIndex: 0
                }
              );
            });

            it('triggers getAndCacheOpenOrdersForSymbol', () => {
              expect(mockGetAndCacheOpenOrdersForSymbol).toHaveBeenCalledWith(
                loggerMock,
                'BTCUPUSDT'
              );
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
                      price: 197.8,
                      quantity: 0.49,
                      side: 'sell',
                      stopPrice: 198,
                      symbol: 'BTCUPUSDT',
                      timeInForce: 'GTC',
                      type: 'STOP_LOSS_LIMIT'
                    }
                  ],
                  sell: {
                    currentPrice: 200,
                    openOrders: [
                      {
                        orderId: 123,
                        price: 197.8,
                        quantity: 0.49,
                        side: 'sell',
                        stopPrice: 198,
                        symbol: 'BTCUPUSDT',
                        timeInForce: 'GTC',
                        type: 'STOP_LOSS_LIMIT'
                      }
                    ],
                    processMessage:
                      'Placed new stop loss limit order for selling of grid trade #1.',
                    updatedAt: expect.any(Object)
                  }
                }
              });
            });
          });

          describe('ALPHABTC', () => {
            beforeEach(async () => {
              mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([
                {
                  orderId: 123,
                  price: 0.00003729,
                  quantity: 5,
                  side: 'sell',
                  stopPrice: 0.00003733,
                  symbol: 'ALPHABTC',
                  timeInForce: 'GTC',
                  type: 'STOP_LOSS_LIMIT'
                }
              ]);
              binanceMock.client.order = jest.fn().mockResolvedValue({
                symbol: 'ALPHABTC',
                orderId: 2701762317,
                orderListId: -1,
                clientOrderId: '6eGYHaJbmJrIS40eoq8ziM',
                transactTime: 1626946722520
              });

              mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
                account: 'info'
              });

              jest.mock('../../../trailingTradeHelper/common', () => ({
                getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
                isExceedAPILimit: mockIsExceedAPILimit,
                getAPILimit: mockGetAPILimit,
                getAndCacheOpenOrdersForSymbol:
                  mockGetAndCacheOpenOrdersForSymbol
              }));

              jest.mock('../../../trailingTradeHelper/order', () => ({
                saveGridTradeOrder: mockSaveGridTradeOrder
              }));

              const step = require('../place-sell-order');

              rawData = {
                symbol: 'ALPHABTC',
                symbolInfo: {
                  filterLotSize: {
                    minQty: '1.00000000',
                    maxQty: '90000000.00000000',
                    stepSize: '1.00000000'
                  },
                  filterPrice: { tickSize: '0.00000001' },
                  filterMinNotional: { minNotional: '0.00010000' }
                },
                symbolConfiguration: {
                  sell: {
                    enabled: true,
                    currentGridTradeIndex: 0,
                    currentGridTrade: {
                      triggerPercentage: 1.03,
                      stopPercentage: 0.99,
                      limitPercentage: 0.989,
                      quantityPercentage: 0.5,
                      executed: false,
                      executedOrder: null
                    }
                  },
                  system: {
                    checkOrderExecutePeriod: 10
                  }
                },
                action: 'sell',
                baseAssetBalance: { free: 11 },
                sell: {
                  currentPrice: 0.00003771,
                  openOrders: []
                }
              };

              result = await step.execute(loggerMock, rawData);
            });

            it('triggers binance.client.order', () => {
              expect(binanceMock.client.order).toHaveBeenCalledWith({
                price: 0.00003729,
                quantity: 5,
                side: 'sell',
                stopPrice: 0.00003733,
                symbol: 'ALPHABTC',
                timeInForce: 'GTC',
                type: 'STOP_LOSS_LIMIT'
              });
            });

            it('triggers saveGridTradeOrder for grid trade last sell order', () => {
              expect(mockSaveGridTradeOrder).toHaveBeenCalledWith(
                loggerMock,
                'ALPHABTC-grid-trade-last-sell-order',
                {
                  symbol: 'ALPHABTC',
                  orderId: 2701762317,
                  orderListId: -1,
                  clientOrderId: '6eGYHaJbmJrIS40eoq8ziM',
                  transactTime: 1626946722520,
                  currentGridTradeIndex: 0
                }
              );
            });

            it('triggers getAndCacheOpenOrdersForSymbol', () => {
              expect(mockGetAndCacheOpenOrdersForSymbol).toHaveBeenCalledWith(
                loggerMock,
                'ALPHABTC'
              );
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
                      price: 0.00003729,
                      quantity: 5,
                      side: 'sell',
                      stopPrice: 0.00003733,
                      symbol: 'ALPHABTC',
                      timeInForce: 'GTC',
                      type: 'STOP_LOSS_LIMIT'
                    }
                  ],
                  sell: {
                    currentPrice: 0.00003771,
                    openOrders: [
                      {
                        orderId: 123,
                        price: 0.00003729,
                        quantity: 5,
                        side: 'sell',
                        stopPrice: 0.00003733,
                        symbol: 'ALPHABTC',
                        timeInForce: 'GTC',
                        type: 'STOP_LOSS_LIMIT'
                      }
                    ],
                    processMessage:
                      'Placed new stop loss limit order for selling of grid trade #1.',
                    updatedAt: expect.any(Object)
                  }
                }
              });
            });
          });

          describe('BTCBRL', () => {
            beforeEach(async () => {
              mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([
                {
                  orderId: 123,
                  price: 265791,
                  quantity: 0.000039,
                  side: 'sell',
                  stopPrice: 266060,
                  symbol: 'BTCBRL',
                  timeInForce: 'GTC',
                  type: 'STOP_LOSS_LIMIT'
                }
              ]);
              binanceMock.client.order = jest.fn().mockResolvedValue({
                symbol: 'BTCBRL',
                orderId: 2701762317,
                orderListId: -1,
                clientOrderId: '6eGYHaJbmJrIS40eoq8ziM',
                transactTime: 1626946722520
              });

              mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
                account: 'info'
              });

              jest.mock('../../../trailingTradeHelper/common', () => ({
                getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
                isExceedAPILimit: mockIsExceedAPILimit,
                getAPILimit: mockGetAPILimit,
                getAndCacheOpenOrdersForSymbol:
                  mockGetAndCacheOpenOrdersForSymbol
              }));

              jest.mock('../../../trailingTradeHelper/order', () => ({
                saveGridTradeOrder: mockSaveGridTradeOrder
              }));

              const step = require('../place-sell-order');

              rawData = {
                symbol: 'BTCBRL',
                symbolInfo: {
                  filterLotSize: {
                    minQty: '0.00000100',
                    maxQty: '9000.00000000',
                    stepSize: '0.00000100'
                  },
                  filterPrice: { tickSize: '1.00000000' },
                  filterMinNotional: { minNotional: '10.00000000' }
                },
                symbolConfiguration: {
                  sell: {
                    enabled: true,
                    currentGridTradeIndex: 0,
                    currentGridTrade: {
                      triggerPercentage: 1.03,
                      stopPercentage: 0.99,
                      limitPercentage: 0.989,
                      quantityPercentage: 0.5,
                      executed: false,
                      executedOrder: null
                    }
                  },
                  system: {
                    checkOrderExecutePeriod: 10
                  }
                },
                action: 'sell',
                baseAssetBalance: { free: 0.00008 },
                sell: {
                  currentPrice: 268748,
                  openOrders: []
                }
              };

              result = await step.execute(loggerMock, rawData);
            });

            it('triggers binance.client.order', () => {
              expect(binanceMock.client.order).toHaveBeenCalledWith({
                price: 265791,
                quantity: 0.000039,
                side: 'sell',
                stopPrice: 266060,
                symbol: 'BTCBRL',
                timeInForce: 'GTC',
                type: 'STOP_LOSS_LIMIT'
              });
            });

            it('triggers saveGridTradeOrder for grid trade last sell order', () => {
              expect(mockSaveGridTradeOrder).toHaveBeenCalledWith(
                loggerMock,
                'BTCBRL-grid-trade-last-sell-order',
                {
                  symbol: 'BTCBRL',
                  orderId: 2701762317,
                  orderListId: -1,
                  clientOrderId: '6eGYHaJbmJrIS40eoq8ziM',
                  transactTime: 1626946722520,
                  currentGridTradeIndex: 0
                }
              );
            });

            it('triggers getAndCacheOpenOrdersForSymbol', () => {
              expect(mockGetAndCacheOpenOrdersForSymbol).toHaveBeenCalledWith(
                loggerMock,
                'BTCBRL'
              );
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
                      price: 265791,
                      quantity: 0.000039,
                      side: 'sell',
                      stopPrice: 266060,
                      symbol: 'BTCBRL',
                      timeInForce: 'GTC',
                      type: 'STOP_LOSS_LIMIT'
                    }
                  ],
                  sell: {
                    currentPrice: 268748,
                    openOrders: [
                      {
                        orderId: 123,
                        price: 265791,
                        quantity: 0.000039,
                        side: 'sell',
                        stopPrice: 266060,
                        symbol: 'BTCBRL',
                        timeInForce: 'GTC',
                        type: 'STOP_LOSS_LIMIT'
                      }
                    ],
                    processMessage:
                      'Placed new stop loss limit order for selling of grid trade #1.',
                    updatedAt: expect.any(Object)
                  }
                }
              });
            });
          });
        });

        describe('when quantity percentage is equal to 1', () => {
          describe('BTCUPUSDT', () => {
            beforeEach(async () => {
              mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([
                {
                  orderId: 123,
                  price: 197.8,
                  quantity: 0.09,
                  side: 'sell',
                  stopPrice: 198,
                  symbol: 'BTCUPUSDT',
                  timeInForce: 'GTC',
                  type: 'STOP_LOSS_LIMIT'
                }
              ]);
              binanceMock.client.order = jest.fn().mockResolvedValue({
                symbol: 'BTCUPUSDT',
                orderId: 2701762317,
                orderListId: -1,
                clientOrderId: '6eGYHaJbmJrIS40eoq8ziM',
                transactTime: 1626946722520
              });

              mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
                account: 'info'
              });

              jest.mock('../../../trailingTradeHelper/common', () => ({
                getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
                isExceedAPILimit: mockIsExceedAPILimit,
                getAPILimit: mockGetAPILimit,
                getAndCacheOpenOrdersForSymbol:
                  mockGetAndCacheOpenOrdersForSymbol
              }));

              jest.mock('../../../trailingTradeHelper/order', () => ({
                saveGridTradeOrder: mockSaveGridTradeOrder
              }));

              const step = require('../place-sell-order');

              rawData = {
                symbol: 'BTCUPUSDT',
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
                    currentGridTradeIndex: 0,
                    currentGridTrade: {
                      triggerPercentage: 1.03,
                      stopPercentage: 0.99,
                      limitPercentage: 0.989,
                      quantityPercentage: 1,
                      executed: false,
                      executedOrder: null
                    }
                  },
                  system: {
                    checkOrderExecutePeriod: 10
                  }
                },
                action: 'sell',
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
                price: 197.8,
                quantity: 0.09,
                side: 'sell',
                stopPrice: 198,
                symbol: 'BTCUPUSDT',
                timeInForce: 'GTC',
                type: 'STOP_LOSS_LIMIT'
              });
            });

            it('triggers saveGridTradeOrder for grid trade last sell order', () => {
              expect(mockSaveGridTradeOrder).toHaveBeenCalledWith(
                loggerMock,
                'BTCUPUSDT-grid-trade-last-sell-order',
                {
                  symbol: 'BTCUPUSDT',
                  orderId: 2701762317,
                  orderListId: -1,
                  clientOrderId: '6eGYHaJbmJrIS40eoq8ziM',
                  transactTime: 1626946722520,
                  currentGridTradeIndex: 0
                }
              );
            });

            it('triggers getAndCacheOpenOrdersForSymbol', () => {
              expect(mockGetAndCacheOpenOrdersForSymbol).toHaveBeenCalledWith(
                loggerMock,
                'BTCUPUSDT'
              );
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
                      price: 197.8,
                      quantity: 0.09,
                      side: 'sell',
                      stopPrice: 198,
                      symbol: 'BTCUPUSDT',
                      timeInForce: 'GTC',
                      type: 'STOP_LOSS_LIMIT'
                    }
                  ],
                  sell: {
                    currentPrice: 200,
                    openOrders: [
                      {
                        orderId: 123,
                        price: 197.8,
                        quantity: 0.09,
                        side: 'sell',
                        stopPrice: 198,
                        symbol: 'BTCUPUSDT',
                        timeInForce: 'GTC',
                        type: 'STOP_LOSS_LIMIT'
                      }
                    ],
                    processMessage:
                      'Placed new stop loss limit order for selling of grid trade #1.',
                    updatedAt: expect.any(Object)
                  }
                }
              });
            });
          });

          describe('ALPHABTC', () => {
            beforeEach(async () => {
              mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([
                {
                  orderId: 123,
                  price: 0.00003729,
                  quantity: 10,
                  side: 'sell',
                  stopPrice: 0.00003733,
                  symbol: 'ALPHABTC',
                  timeInForce: 'GTC',
                  type: 'STOP_LOSS_LIMIT'
                }
              ]);
              binanceMock.client.order = jest.fn().mockResolvedValue({
                symbol: 'ALPHABTC',
                orderId: 2701762317,
                orderListId: -1,
                clientOrderId: '6eGYHaJbmJrIS40eoq8ziM',
                transactTime: 1626946722520
              });

              mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
                account: 'info'
              });

              jest.mock('../../../trailingTradeHelper/common', () => ({
                getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
                isExceedAPILimit: mockIsExceedAPILimit,
                getAPILimit: mockGetAPILimit,
                getAndCacheOpenOrdersForSymbol:
                  mockGetAndCacheOpenOrdersForSymbol
              }));

              jest.mock('../../../trailingTradeHelper/order', () => ({
                saveGridTradeOrder: mockSaveGridTradeOrder
              }));

              const step = require('../place-sell-order');

              rawData = {
                symbol: 'ALPHABTC',
                symbolInfo: {
                  filterLotSize: {
                    minQty: '1.00000000',
                    maxQty: '90000000.00000000',
                    stepSize: '1.00000000'
                  },
                  filterPrice: { tickSize: '0.00000001' },
                  filterMinNotional: { minNotional: '0.00010000' }
                },
                symbolConfiguration: {
                  sell: {
                    enabled: true,
                    currentGridTradeIndex: 0,
                    currentGridTrade: {
                      triggerPercentage: 1.03,
                      stopPercentage: 0.99,
                      limitPercentage: 0.989,
                      quantityPercentage: 1,
                      executed: false,
                      executedOrder: null
                    }
                  },
                  system: {
                    checkOrderExecutePeriod: 10
                  }
                },
                action: 'sell',
                baseAssetBalance: { free: 11 },
                sell: {
                  currentPrice: 0.00003771,
                  openOrders: []
                }
              };

              result = await step.execute(loggerMock, rawData);
            });

            it('triggers binance.client.order', () => {
              expect(binanceMock.client.order).toHaveBeenCalledWith({
                price: 0.00003729,
                quantity: 10,
                side: 'sell',
                stopPrice: 0.00003733,
                symbol: 'ALPHABTC',
                timeInForce: 'GTC',
                type: 'STOP_LOSS_LIMIT'
              });
            });

            it('triggers saveGridTradeOrder for grid trade last sell order', () => {
              expect(mockSaveGridTradeOrder).toHaveBeenCalledWith(
                loggerMock,
                'ALPHABTC-grid-trade-last-sell-order',
                {
                  symbol: 'ALPHABTC',
                  orderId: 2701762317,
                  orderListId: -1,
                  clientOrderId: '6eGYHaJbmJrIS40eoq8ziM',
                  transactTime: 1626946722520,
                  currentGridTradeIndex: 0
                }
              );
            });

            it('triggers getAndCacheOpenOrdersForSymbol', () => {
              expect(mockGetAndCacheOpenOrdersForSymbol).toHaveBeenCalledWith(
                loggerMock,
                'ALPHABTC'
              );
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
                      price: 0.00003729,
                      quantity: 10,
                      side: 'sell',
                      stopPrice: 0.00003733,
                      symbol: 'ALPHABTC',
                      timeInForce: 'GTC',
                      type: 'STOP_LOSS_LIMIT'
                    }
                  ],
                  sell: {
                    currentPrice: 0.00003771,
                    openOrders: [
                      {
                        orderId: 123,
                        price: 0.00003729,
                        quantity: 10,
                        side: 'sell',
                        stopPrice: 0.00003733,
                        symbol: 'ALPHABTC',
                        timeInForce: 'GTC',
                        type: 'STOP_LOSS_LIMIT'
                      }
                    ],
                    processMessage:
                      'Placed new stop loss limit order for selling of grid trade #1.',
                    updatedAt: expect.any(Object)
                  }
                }
              });
            });
          });

          describe('BTCBRL', () => {
            beforeEach(async () => {
              mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([
                {
                  orderId: 123,
                  price: 265791,
                  quantity: 0.0999,
                  side: 'sell',
                  stopPrice: 266060,
                  symbol: 'BTCBRL',
                  timeInForce: 'GTC',
                  type: 'STOP_LOSS_LIMIT'
                }
              ]);
              binanceMock.client.order = jest.fn().mockResolvedValue({
                symbol: 'BTCBRL',
                orderId: 2701762317,
                orderListId: -1,
                clientOrderId: '6eGYHaJbmJrIS40eoq8ziM',
                transactTime: 1626946722520
              });

              mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
                account: 'info'
              });

              jest.mock('../../../trailingTradeHelper/common', () => ({
                getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
                isExceedAPILimit: mockIsExceedAPILimit,
                getAPILimit: mockGetAPILimit,
                getAndCacheOpenOrdersForSymbol:
                  mockGetAndCacheOpenOrdersForSymbol
              }));

              jest.mock('../../../trailingTradeHelper/order', () => ({
                saveGridTradeOrder: mockSaveGridTradeOrder
              }));

              const step = require('../place-sell-order');

              rawData = {
                symbol: 'BTCBRL',
                symbolInfo: {
                  filterLotSize: {
                    minQty: '0.00000100',
                    maxQty: '9000.00000000',
                    stepSize: '0.00000100'
                  },
                  filterPrice: { tickSize: '1.00000000' },
                  filterMinNotional: { minNotional: '10.00000000' }
                },
                symbolConfiguration: {
                  sell: {
                    enabled: true,
                    currentGridTradeIndex: 0,
                    currentGridTrade: {
                      triggerPercentage: 1.03,
                      stopPercentage: 0.99,
                      limitPercentage: 0.989,
                      quantityPercentage: 1,
                      executed: false,
                      executedOrder: null
                    }
                  },
                  system: {
                    checkOrderExecutePeriod: 10
                  }
                },
                action: 'sell',
                baseAssetBalance: { free: 0.1 },
                sell: {
                  currentPrice: 268748,
                  openOrders: []
                }
              };

              result = await step.execute(loggerMock, rawData);
            });

            it('triggers binance.client.order', () => {
              expect(binanceMock.client.order).toHaveBeenCalledWith({
                price: 265791,
                quantity: 0.0999,
                side: 'sell',
                stopPrice: 266060,
                symbol: 'BTCBRL',
                timeInForce: 'GTC',
                type: 'STOP_LOSS_LIMIT'
              });
            });

            it('triggers saveGridTradeOrder for grid trade last sell order', () => {
              expect(mockSaveGridTradeOrder).toHaveBeenCalledWith(
                loggerMock,
                'BTCBRL-grid-trade-last-sell-order',
                {
                  symbol: 'BTCBRL',
                  orderId: 2701762317,
                  orderListId: -1,
                  clientOrderId: '6eGYHaJbmJrIS40eoq8ziM',
                  transactTime: 1626946722520,
                  currentGridTradeIndex: 0
                }
              );
            });

            it('triggers getAndCacheOpenOrdersForSymbol', () => {
              expect(mockGetAndCacheOpenOrdersForSymbol).toHaveBeenCalledWith(
                loggerMock,
                'BTCBRL'
              );
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
                      price: 265791,
                      quantity: 0.0999,
                      side: 'sell',
                      stopPrice: 266060,
                      symbol: 'BTCBRL',
                      timeInForce: 'GTC',
                      type: 'STOP_LOSS_LIMIT'
                    }
                  ],
                  sell: {
                    currentPrice: 268748,
                    openOrders: [
                      {
                        orderId: 123,
                        price: 265791,
                        quantity: 0.0999,
                        side: 'sell',
                        stopPrice: 266060,
                        symbol: 'BTCBRL',
                        timeInForce: 'GTC',
                        type: 'STOP_LOSS_LIMIT'
                      }
                    ],
                    processMessage:
                      'Placed new stop loss limit order for selling of grid trade #1.',
                    updatedAt: expect.any(Object)
                  }
                }
              });
            });
          });

          describe('ONGUSDT', () => {
            beforeEach(async () => {
              mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([
                {
                  orderId: 123,
                  price: 1.0096,
                  quantity: 100,
                  side: 'sell',
                  stopPrice: 1.0175,
                  symbol: 'ONGUSDT',
                  timeInForce: 'GTC',
                  type: 'STOP_LOSS_LIMIT'
                }
              ]);
              binanceMock.client.order = jest.fn().mockResolvedValue({
                symbol: 'ONGUSDT',
                orderId: 2701762317,
                orderListId: -1,
                clientOrderId: '6eGYHaJbmJrIS40eoq8ziM',
                transactTime: 1626946722520
              });

              mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
                account: 'info'
              });

              jest.mock('../../../trailingTradeHelper/common', () => ({
                getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
                isExceedAPILimit: mockIsExceedAPILimit,
                getAPILimit: mockGetAPILimit,
                getAndCacheOpenOrdersForSymbol:
                  mockGetAndCacheOpenOrdersForSymbol
              }));

              jest.mock('../../../trailingTradeHelper/order', () => ({
                saveGridTradeOrder: mockSaveGridTradeOrder
              }));

              const step = require('../place-sell-order');

              rawData = {
                symbol: 'ONGUSDT',
                symbolInfo: {
                  filterLotSize: {
                    minQty: '1.00000000',
                    maxQty: '900000.00000000',
                    stepSize: '1.00000000'
                  },
                  filterPrice: { tickSize: '0.00010000' },
                  filterMinNotional: { minNotional: '10.00000000' }
                },
                symbolConfiguration: {
                  sell: {
                    enabled: true,
                    currentGridTradeIndex: 0,
                    currentGridTrade: {
                      triggerPercentage: 1.02,
                      stopPercentage: 0.99675,
                      limitPercentage: 0.989,
                      quantityPercentage: 1,
                      executed: false,
                      executedOrder: null
                    }
                  },
                  system: {
                    checkOrderExecutePeriod: 10
                  }
                },
                action: 'sell',
                baseAssetBalance: { free: 120.25495 },
                sell: {
                  currentPrice: 1.0209,
                  openOrders: []
                }
              };

              result = await step.execute(loggerMock, rawData);
            });

            it('triggers binance.client.order', () => {
              expect(binanceMock.client.order).toHaveBeenCalledWith({
                price: 1.0096,
                quantity: 119,
                side: 'sell',
                stopPrice: 1.0175,
                symbol: 'ONGUSDT',
                timeInForce: 'GTC',
                type: 'STOP_LOSS_LIMIT'
              });
            });

            it('triggers saveGridTradeOrder for grid trade last sell order', () => {
              expect(mockSaveGridTradeOrder).toHaveBeenCalledWith(
                loggerMock,
                'ONGUSDT-grid-trade-last-sell-order',
                {
                  symbol: 'ONGUSDT',
                  orderId: 2701762317,
                  orderListId: -1,
                  clientOrderId: '6eGYHaJbmJrIS40eoq8ziM',
                  transactTime: 1626946722520,
                  currentGridTradeIndex: 0
                }
              );
            });

            it('triggers getAndCacheOpenOrdersForSymbol', () => {
              expect(mockGetAndCacheOpenOrdersForSymbol).toHaveBeenCalledWith(
                loggerMock,
                'ONGUSDT'
              );
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
                      price: 1.0096,
                      quantity: 100,
                      side: 'sell',
                      stopPrice: 1.0175,
                      symbol: 'ONGUSDT',
                      timeInForce: 'GTC',
                      type: 'STOP_LOSS_LIMIT'
                    }
                  ],
                  sell: {
                    currentPrice: 1.0209,
                    openOrders: [
                      {
                        orderId: 123,
                        price: 1.0096,
                        quantity: 100,
                        side: 'sell',
                        stopPrice: 1.0175,
                        symbol: 'ONGUSDT',
                        timeInForce: 'GTC',
                        type: 'STOP_LOSS_LIMIT'
                      }
                    ],
                    processMessage:
                      'Placed new stop loss limit order for selling of grid trade #1.',
                    updatedAt: expect.any(Object)
                  }
                }
              });
            });
          });
        });
      });
    });
  });
});
