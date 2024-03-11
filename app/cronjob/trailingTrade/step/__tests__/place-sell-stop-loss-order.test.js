/* eslint-disable global-require */

describe('place-sell-stop-loss-order.js', () => {
  let result;
  let rawData;

  let binanceMock;
  let slackMock;
  let loggerMock;

  let mockGetAccountInfoFromAPI;
  let mockIsExceedAPILimit;
  let mockDisableAction;
  let mockGetAPILimit;
  let mockGetAndCacheOpenOrdersForSymbol;

  let mockSaveSymbolGridTrade;

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
      mockDisableAction = jest.fn().mockResolvedValue(true);
      mockGetAPILimit = jest.fn().mockReturnValueOnce(10);

      mockSaveSymbolGridTrade = jest.fn().mockResolvedValue(true);

      mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([]);
    });

    describe('when action is not sell-stop-loss', () => {
      beforeEach(async () => {
        mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([]);
        mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
          account: 'info'
        });

        jest.mock('../../../trailingTradeHelper/common', () => ({
          getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
          isExceedAPILimit: mockIsExceedAPILimit,
          disableAction: mockDisableAction,
          getAPILimit: mockGetAPILimit,
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol
        }));

        jest.mock('../../../trailingTradeHelper/configuration', () => ({
          saveSymbolGridTrade: mockSaveSymbolGridTrade
        }));

        const step = require('../place-sell-stop-loss-order');

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
            buy: { gridTrade: [] },
            sell: {
              enabled: true,
              gridTrade: [],
              stopLoss: {
                orderType: 'market',
                disableBuyMinutes: 60
              }
            }
          },
          action: 'not-determined',
          baseAssetBalance: { free: 0.5 },
          sell: { currentPrice: 200, openOrders: [] },
          canDisable: true
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

      it('does not trigger saveSymbolGridTrade', () => {
        expect(mockSaveSymbolGridTrade).not.toHaveBeenCalled();
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
          getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
          isExceedAPILimit: mockIsExceedAPILimit,
          disableAction: mockDisableAction,
          getAPILimit: mockGetAPILimit,
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol
        }));

        jest.mock('../../../trailingTradeHelper/configuration', () => ({
          saveSymbolGridTrade: mockSaveSymbolGridTrade
        }));

        const step = require('../place-sell-stop-loss-order');

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
            buy: { gridTrade: [] },
            sell: {
              enabled: true,
              gridTrade: [],
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
          },
          canDisable: true
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

      it('does not trigger saveSymbolGridTrade', () => {
        expect(mockSaveSymbolGridTrade).not.toHaveBeenCalled();
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
      describe('BTCUPUSDT', () => {
        beforeEach(async () => {
          mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([]);
          mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
            account: 'info'
          });

          jest.mock('../../../trailingTradeHelper/common', () => ({
            getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
            isExceedAPILimit: mockIsExceedAPILimit,
            disableAction: mockDisableAction,
            getAPILimit: mockGetAPILimit,
            getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol
          }));

          jest.mock('../../../trailingTradeHelper/configuration', () => ({
            saveSymbolGridTrade: mockSaveSymbolGridTrade
          }));

          const step = require('../place-sell-stop-loss-order');

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
              buy: { gridTrade: [] },
              sell: {
                enabled: true,
                gridTrade: [],
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
            },
            canDisable: true
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

        it('does not trigger saveSymbolGridTrade', () => {
          expect(mockSaveSymbolGridTrade).not.toHaveBeenCalled();
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

      describe('ALPHABTC', () => {
        beforeEach(async () => {
          mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([]);
          mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
            account: 'info'
          });

          jest.mock('../../../trailingTradeHelper/common', () => ({
            getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
            isExceedAPILimit: mockIsExceedAPILimit,
            disableAction: mockDisableAction,
            getAPILimit: mockGetAPILimit,
            getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol
          }));

          jest.mock('../../../trailingTradeHelper/configuration', () => ({
            saveSymbolGridTrade: mockSaveSymbolGridTrade
          }));

          const step = require('../place-sell-stop-loss-order');

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
              buy: { gridTrade: [] },
              sell: {
                enabled: true,
                gridTrade: [],
                stopLoss: {
                  orderType: 'market',
                  disableBuyMinutes: 60
                }
              }
            },
            action: 'sell-stop-loss',
            baseAssetBalance: { free: 1 },
            sell: {
              currentPrice: 200,
              openOrders: []
            },
            canDisable: true
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

        it('does not trigger saveSymbolGridTrade', () => {
          expect(mockSaveSymbolGridTrade).not.toHaveBeenCalled();
        });

        it('retruns expected value', () => {
          expect(result).toStrictEqual({
            ...rawData,
            ...{
              sell: {
                currentPrice: 200,
                openOrders: [],
                processMessage:
                  `Order quantity is less or equal than the minimum quantity - 1.00000000. ` +
                  `Do not place a stop-loss order.`,
                updatedAt: expect.any(Object)
              }
            }
          });
        });
      });

      describe('BTCBRL', () => {
        beforeEach(async () => {
          mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([]);
          mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
            account: 'info'
          });

          jest.mock('../../../trailingTradeHelper/common', () => ({
            getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
            isExceedAPILimit: mockIsExceedAPILimit,
            disableAction: mockDisableAction,
            getAPILimit: mockGetAPILimit,
            getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol
          }));

          jest.mock('../../../trailingTradeHelper/configuration', () => ({
            saveSymbolGridTrade: mockSaveSymbolGridTrade
          }));

          const step = require('../place-sell-stop-loss-order');

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
              buy: { gridTrade: [] },
              sell: {
                enabled: true,
                gridTrade: [],
                stopLoss: {
                  orderType: 'market',
                  disableBuyMinutes: 60
                }
              }
            },
            action: 'sell-stop-loss',
            baseAssetBalance: { free: 0.000001 },
            sell: {
              currentPrice: 268748,
              openOrders: []
            },
            canDisable: true
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

        it('does not trigger saveSymbolGridTrade', () => {
          expect(mockSaveSymbolGridTrade).not.toHaveBeenCalled();
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
                  `Do not place a stop-loss order.`,
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
          mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([]);
          mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
            account: 'info'
          });

          jest.mock('../../../trailingTradeHelper/common', () => ({
            getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
            isExceedAPILimit: mockIsExceedAPILimit,
            disableAction: mockDisableAction,
            getAPILimit: mockGetAPILimit,
            getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol
          }));

          jest.mock('../../../trailingTradeHelper/configuration', () => ({
            saveSymbolGridTrade: mockSaveSymbolGridTrade
          }));

          const step = require('../place-sell-stop-loss-order');

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
              buy: { gridTrade: [] },
              sell: {
                enabled: true,
                gridTrade: [],
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
            },
            canDisable: true
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

        it('does not trigger saveSymbolGridTrade', () => {
          expect(mockSaveSymbolGridTrade).not.toHaveBeenCalled();
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

      describe('ALPHABTC', () => {
        beforeEach(async () => {
          mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([]);
          mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
            account: 'info'
          });

          jest.mock('../../../trailingTradeHelper/common', () => ({
            getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
            isExceedAPILimit: mockIsExceedAPILimit,
            disableAction: mockDisableAction,
            getAPILimit: mockGetAPILimit,
            getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol
          }));

          jest.mock('../../../trailingTradeHelper/configuration', () => ({
            saveSymbolGridTrade: mockSaveSymbolGridTrade
          }));

          const step = require('../place-sell-stop-loss-order');

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
              buy: { gridTrade: [] },
              sell: {
                enabled: true,
                gridTrade: [],
                stopLoss: {
                  orderType: 'market',
                  disableBuyMinutes: 60
                }
              }
            },
            action: 'sell-stop-loss',
            baseAssetBalance: { free: 3 },
            sell: {
              currentPrice: 0.00003771,
              openOrders: []
            },
            canDisable: true
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

        it('does not trigger saveSymbolGridTrade', () => {
          expect(mockSaveSymbolGridTrade).not.toHaveBeenCalled();
        });

        it('retruns expected value', () => {
          expect(result).toStrictEqual({
            ...rawData,
            ...{
              sell: {
                currentPrice: 0.00003771,
                openOrders: [],
                processMessage:
                  'Notional value is less than the minimum notional value. Do not place a stop-loss order.',
                updatedAt: expect.any(Object)
              }
            }
          });
        });
      });

      describe('BTCBRL', () => {
        beforeEach(async () => {
          mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([]);
          mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
            account: 'info'
          });

          jest.mock('../../../trailingTradeHelper/common', () => ({
            getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
            isExceedAPILimit: mockIsExceedAPILimit,
            disableAction: mockDisableAction,
            getAPILimit: mockGetAPILimit,
            getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol
          }));

          jest.mock('../../../trailingTradeHelper/configuration', () => ({
            saveSymbolGridTrade: mockSaveSymbolGridTrade
          }));

          const step = require('../place-sell-stop-loss-order');

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
              buy: { gridTrade: [] },
              sell: {
                enabled: true,
                gridTrade: [],
                stopLoss: {
                  orderType: 'market',
                  disableBuyMinutes: 60
                }
              }
            },
            action: 'sell-stop-loss',
            baseAssetBalance: { free: 0.00003 },
            sell: {
              currentPrice: 268748,
              openOrders: []
            },
            canDisable: true
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

        it('does not trigger saveSymbolGridTrade', () => {
          expect(mockSaveSymbolGridTrade).not.toHaveBeenCalled();
        });

        it('retruns expected value', () => {
          expect(result).toStrictEqual({
            ...rawData,
            ...{
              sell: {
                currentPrice: 268748,
                openOrders: [],
                processMessage:
                  'Notional value is less than the minimum notional value. Do not place a stop-loss order.',
                updatedAt: expect.any(Object)
              }
            }
          });
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
          getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
          isExceedAPILimit: mockIsExceedAPILimit,
          disableAction: mockDisableAction,
          getAPILimit: mockGetAPILimit,
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol
        }));

        jest.mock('../../../trailingTradeHelper/configuration', () => ({
          saveSymbolGridTrade: mockSaveSymbolGridTrade
        }));

        const step = require('../place-sell-stop-loss-order');

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
            buy: { gridTrade: [] },
            sell: {
              enabled: false,
              gridTrade: [],
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
          },
          canDisable: true
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

      it('does not trigger saveSymbolGridTrade', () => {
        expect(mockSaveSymbolGridTrade).not.toHaveBeenCalled();
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

    describe('when API limit is exceeded', () => {
      beforeEach(async () => {
        mockIsExceedAPILimit = jest.fn().mockReturnValue(true);

        mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([]);
        mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
          account: 'info'
        });

        jest.mock('../../../trailingTradeHelper/common', () => ({
          getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
          isExceedAPILimit: mockIsExceedAPILimit,
          disableAction: mockDisableAction,
          getAPILimit: mockGetAPILimit,
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol
        }));

        jest.mock('../../../trailingTradeHelper/configuration', () => ({
          saveSymbolGridTrade: mockSaveSymbolGridTrade
        }));

        const step = require('../place-sell-stop-loss-order');

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
            buy: { gridTrade: [] },
            sell: {
              enabled: true,
              gridTrade: [],
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
          },
          canDisable: true
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

      it('does not trigger saveSymbolGridTrade', () => {
        expect(mockSaveSymbolGridTrade).not.toHaveBeenCalled();
      });

      it('retruns expected value', () => {
        expect(result).toStrictEqual({
          ...rawData,
          ...{
            sell: {
              currentPrice: 200,
              openOrders: [],
              processMessage:
                'Binance API limit has been exceeded. Do not place a stop-loss order.',
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
          getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
          isExceedAPILimit: mockIsExceedAPILimit,
          disableAction: mockDisableAction,
          getAPILimit: mockGetAPILimit,
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol
        }));

        jest.mock('../../../trailingTradeHelper/configuration', () => ({
          saveSymbolGridTrade: mockSaveSymbolGridTrade
        }));

        const step = require('../place-sell-stop-loss-order');

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
            buy: { gridTrade: [] },
            sell: {
              enabled: true,
              gridTrade: [],
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
          },
          canDisable: true
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

      it('does not trigger saveSymbolGridTrade', () => {
        expect(mockSaveSymbolGridTrade).not.toHaveBeenCalled();
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
        describe('BTCUPUSDT', () => {
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

            binanceMock.client.order = jest.fn().mockResolvedValue({
              symbol: 'BTCUPUSDT',
              orderId: 2701762317,
              orderListId: -1,
              clientOrderId: '6eGYHaJbmJrIS40eoq8ziM',
              transactTime: 1626946722520
            });

            jest.mock('../../../trailingTradeHelper/common', () => ({
              getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
              isExceedAPILimit: mockIsExceedAPILimit,
              disableAction: mockDisableAction,
              getAPILimit: mockGetAPILimit,
              getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol
            }));

            jest.mock('../../../trailingTradeHelper/configuration', () => ({
              saveSymbolGridTrade: mockSaveSymbolGridTrade
            }));

            const step = require('../place-sell-stop-loss-order');

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
                buy: {
                  gridTrade: [
                    {
                      executed: true,
                      executedOrder: {
                        symbol: 'BTCUPUSDT',
                        orderId: 2792607,
                        cummulativeQuoteQty: '14.97195000',
                        status: 'FILLED',
                        type: 'STOP_LOSS_LIMIT',
                        side: 'BUY'
                      }
                    }
                  ]
                },
                sell: {
                  enabled: true,
                  gridTrade: [
                    {
                      executed: false,
                      executedOrder: null
                    }
                  ],
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
              },
              canDisable: true
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

          it('triggers disableAction', () => {
            expect(mockDisableAction).toHaveBeenCalledWith(
              loggerMock,
              'BTCUPUSDT',
              {
                disabledBy: 'stop loss',
                message: 'Temporary disabled by stop loss',
                canResume: true,
                canRemoveLastBuyPrice: true
              },
              60 * 60
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

          it('triggers saveSymbolGridTrade', () => {
            expect(mockSaveSymbolGridTrade).toHaveBeenCalledWith(
              loggerMock,
              'BTCUPUSDT',
              {
                buy: [
                  {
                    executed: true,
                    executedOrder: {
                      symbol: 'BTCUPUSDT',
                      orderId: 2792607,
                      cummulativeQuoteQty: '14.97195000',
                      status: 'FILLED',
                      type: 'STOP_LOSS_LIMIT',
                      side: 'BUY'
                    }
                  }
                ],
                sell: [
                  {
                    executed: false,
                    executedOrder: null
                  }
                ],
                stopLoss: {
                  symbol: 'BTCUPUSDT',
                  orderId: 2701762317,
                  orderListId: -1,
                  clientOrderId: '6eGYHaJbmJrIS40eoq8ziM',
                  transactTime: 1626946722520
                }
              }
            );
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

        describe('ALPHABTC', () => {
          beforeEach(async () => {
            mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([
              {
                orderId: 123,
                quantity: 19,
                side: 'sell',
                symbol: 'ALPHABTC',
                type: 'MARKET'
              }
            ]);
            mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
              account: 'info'
            });

            binanceMock.client.order = jest.fn().mockResolvedValue({
              symbol: 'ALPHABTC',
              orderId: 2701762317,
              orderListId: -1,
              clientOrderId: '6eGYHaJbmJrIS40eoq8ziM',
              transactTime: 1626946722520
            });

            jest.mock('../../../trailingTradeHelper/common', () => ({
              getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
              isExceedAPILimit: mockIsExceedAPILimit,
              disableAction: mockDisableAction,
              getAPILimit: mockGetAPILimit,
              getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol
            }));

            jest.mock('../../../trailingTradeHelper/configuration', () => ({
              saveSymbolGridTrade: mockSaveSymbolGridTrade
            }));

            const step = require('../place-sell-stop-loss-order');

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
                buy: {
                  gridTrade: [
                    {
                      executed: true,
                      executedOrder: {
                        symbol: 'ALPHABTC',
                        orderId: 2792607,
                        cummulativeQuoteQty: '14.97195000',
                        status: 'FILLED',
                        type: 'STOP_LOSS_LIMIT',
                        side: 'BUY'
                      }
                    }
                  ]
                },
                sell: {
                  enabled: true,
                  gridTrade: [
                    {
                      executed: true,
                      executedOrder: {
                        symbol: 'ALPHABTC',
                        orderId: 2792607,
                        cummulativeQuoteQty: '14.97195000',
                        status: 'FILLED',
                        type: 'STOP_LOSS_LIMIT',
                        side: 'SELL'
                      }
                    }
                  ],
                  stopLoss: {
                    orderType: 'market',
                    disableBuyMinutes: 60
                  }
                }
              },
              action: 'sell-stop-loss',
              baseAssetBalance: { free: 20 },
              sell: {
                currentPrice: 0.00003771,
                openOrders: []
              },
              canDisable: true
            };

            result = await step.execute(loggerMock, rawData);
          });

          it('triggers binance.client.order', () => {
            expect(binanceMock.client.order).toHaveBeenCalledWith({
              symbol: 'ALPHABTC',
              side: 'sell',
              type: 'MARKET',
              quantity: 19
            });
          });

          it('triggers disableAction', () => {
            expect(mockDisableAction).toHaveBeenCalledWith(
              loggerMock,
              'ALPHABTC',
              {
                disabledBy: 'stop loss',
                message: 'Temporary disabled by stop loss',
                canResume: true,
                canRemoveLastBuyPrice: true
              },
              60 * 60
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

          it('triggers saveSymbolGridTrade', () => {
            expect(mockSaveSymbolGridTrade).toHaveBeenCalledWith(
              loggerMock,
              'ALPHABTC',
              {
                buy: [
                  {
                    executed: true,
                    executedOrder: {
                      symbol: 'ALPHABTC',
                      orderId: 2792607,
                      cummulativeQuoteQty: '14.97195000',
                      status: 'FILLED',
                      type: 'STOP_LOSS_LIMIT',
                      side: 'BUY'
                    }
                  }
                ],
                sell: [
                  {
                    executed: true,
                    executedOrder: {
                      symbol: 'ALPHABTC',
                      orderId: 2792607,
                      cummulativeQuoteQty: '14.97195000',
                      status: 'FILLED',
                      type: 'STOP_LOSS_LIMIT',
                      side: 'SELL'
                    }
                  }
                ],
                stopLoss: {
                  symbol: 'ALPHABTC',
                  orderId: 2701762317,
                  orderListId: -1,
                  clientOrderId: '6eGYHaJbmJrIS40eoq8ziM',
                  transactTime: 1626946722520
                }
              }
            );
          });

          it('retruns expected value', () => {
            expect(result).toStrictEqual({
              ...rawData,
              ...{
                openOrders: [
                  {
                    orderId: 123,
                    quantity: 19,
                    side: 'sell',
                    symbol: 'ALPHABTC',
                    type: 'MARKET'
                  }
                ],
                sell: {
                  currentPrice: 0.00003771,
                  openOrders: [
                    {
                      orderId: 123,
                      quantity: 19,
                      side: 'sell',
                      symbol: 'ALPHABTC',
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

        describe('BTCBRL', () => {
          beforeEach(async () => {
            mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([
              {
                orderId: 123,
                quantity: 9000,
                side: 'sell',
                symbol: 'BTCBRL',
                type: 'MARKET'
              }
            ]);
            mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
              account: 'info'
            });

            binanceMock.client.order = jest.fn().mockResolvedValue({
              symbol: 'BTCBRL',
              orderId: 2701762317,
              orderListId: -1,
              clientOrderId: '6eGYHaJbmJrIS40eoq8ziM',
              transactTime: 1626946722520
            });

            jest.mock('../../../trailingTradeHelper/common', () => ({
              getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
              isExceedAPILimit: mockIsExceedAPILimit,
              disableAction: mockDisableAction,
              getAPILimit: mockGetAPILimit,
              getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol
            }));

            jest.mock('../../../trailingTradeHelper/configuration', () => ({
              saveSymbolGridTrade: mockSaveSymbolGridTrade
            }));

            const step = require('../place-sell-stop-loss-order');

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
                buy: {
                  gridTrade: [
                    {
                      executed: true,
                      executedOrder: {
                        symbol: 'BTCBRL',
                        orderId: 2792607,
                        cummulativeQuoteQty: '14.97195000',
                        status: 'FILLED',
                        type: 'STOP_LOSS_LIMIT',
                        side: 'BUY'
                      }
                    }
                  ]
                },
                sell: {
                  enabled: true,
                  gridTrade: [
                    {
                      executed: true,
                      executedOrder: {
                        symbol: 'BTCBRL',
                        orderId: 2792607,
                        cummulativeQuoteQty: '14.97195000',
                        status: 'FILLED',
                        type: 'STOP_LOSS_LIMIT',
                        side: 'BUY'
                      }
                    }
                  ],
                  stopLoss: {
                    orderType: 'market',
                    disableBuyMinutes: 60
                  }
                }
              },
              action: 'sell-stop-loss',
              baseAssetBalance: { free: 10000 },
              sell: {
                currentPrice: 268748,
                openOrders: []
              },
              canDisable: true
            };

            result = await step.execute(loggerMock, rawData);
          });

          it('triggers binance.client.order', () => {
            expect(binanceMock.client.order).toHaveBeenCalledWith({
              symbol: 'BTCBRL',
              side: 'sell',
              type: 'MARKET',
              quantity: 9000
            });
          });

          it('triggers disableAction', () => {
            expect(mockDisableAction).toHaveBeenCalledWith(
              loggerMock,
              'BTCBRL',
              {
                disabledBy: 'stop loss',
                message: 'Temporary disabled by stop loss',
                canResume: true,
                canRemoveLastBuyPrice: true
              },
              60 * 60
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

          it('triggers saveSymbolGridTrade', () => {
            expect(mockSaveSymbolGridTrade).toHaveBeenCalledWith(
              loggerMock,
              'BTCBRL',
              {
                buy: [
                  {
                    executed: true,
                    executedOrder: {
                      symbol: 'BTCBRL',
                      orderId: 2792607,
                      cummulativeQuoteQty: '14.97195000',
                      status: 'FILLED',
                      type: 'STOP_LOSS_LIMIT',
                      side: 'BUY'
                    }
                  }
                ],
                sell: [
                  {
                    executed: true,
                    executedOrder: {
                      symbol: 'BTCBRL',
                      orderId: 2792607,
                      cummulativeQuoteQty: '14.97195000',
                      status: 'FILLED',
                      type: 'STOP_LOSS_LIMIT',
                      side: 'BUY'
                    }
                  }
                ],
                stopLoss: {
                  symbol: 'BTCBRL',
                  orderId: 2701762317,
                  orderListId: -1,
                  clientOrderId: '6eGYHaJbmJrIS40eoq8ziM',
                  transactTime: 1626946722520
                }
              }
            );
          });

          it('retruns expected value', () => {
            expect(result).toStrictEqual({
              ...rawData,
              ...{
                openOrders: [
                  {
                    orderId: 123,
                    quantity: 9000,
                    side: 'sell',
                    symbol: 'BTCBRL',
                    type: 'MARKET'
                  }
                ],
                sell: {
                  currentPrice: 268748,
                  openOrders: [
                    {
                      orderId: 123,
                      quantity: 9000,
                      side: 'sell',
                      symbol: 'BTCBRL',
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

      describe('when the quality is less than maximum quantity', () => {
        describe('BTCUPUSDT', () => {
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

            binanceMock.client.order = jest.fn().mockResolvedValue({
              symbol: 'BTCUPUSDT',
              orderId: 2701762317,
              orderListId: -1,
              clientOrderId: '6eGYHaJbmJrIS40eoq8ziM',
              transactTime: 1626946722520
            });

            jest.mock('../../../trailingTradeHelper/common', () => ({
              getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
              isExceedAPILimit: mockIsExceedAPILimit,
              disableAction: mockDisableAction,
              getAPILimit: mockGetAPILimit,
              getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol
            }));

            jest.mock('../../../trailingTradeHelper/configuration', () => ({
              saveSymbolGridTrade: mockSaveSymbolGridTrade
            }));

            const step = require('../place-sell-stop-loss-order');

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
                buy: {
                  gridTrade: [
                    {
                      executed: true,
                      executedOrder: {
                        symbol: 'BTCUPUSDT',
                        orderId: 2792607,
                        cummulativeQuoteQty: '14.97195000',
                        status: 'FILLED',
                        type: 'STOP_LOSS_LIMIT',
                        side: 'BUY'
                      }
                    }
                  ]
                },
                sell: {
                  enabled: true,
                  gridTrade: [
                    {
                      executed: true,
                      executedOrder: {
                        symbol: 'BTCUPUSDT',
                        orderId: 2792607,
                        cummulativeQuoteQty: '14.97195000',
                        status: 'FILLED',
                        type: 'STOP_LOSS_LIMIT',
                        side: 'SELL'
                      }
                    }
                  ],
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
              },
              canDisable: false
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

          it('does not trigger disableAction', () => {
            expect(mockDisableAction).not.toHaveBeenCalled();
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

          it('does not trigger saveSymbolGridTrade', () => {
            expect(mockSaveSymbolGridTrade).toHaveBeenCalledWith(
              loggerMock,
              'BTCUPUSDT',
              {
                buy: [
                  {
                    executed: true,
                    executedOrder: {
                      symbol: 'BTCUPUSDT',
                      orderId: 2792607,
                      cummulativeQuoteQty: '14.97195000',
                      status: 'FILLED',
                      type: 'STOP_LOSS_LIMIT',
                      side: 'BUY'
                    }
                  }
                ],
                sell: [
                  {
                    executed: true,
                    executedOrder: {
                      symbol: 'BTCUPUSDT',
                      orderId: 2792607,
                      cummulativeQuoteQty: '14.97195000',
                      status: 'FILLED',
                      type: 'STOP_LOSS_LIMIT',
                      side: 'SELL'
                    }
                  }
                ],
                stopLoss: {
                  symbol: 'BTCUPUSDT',
                  orderId: 2701762317,
                  orderListId: -1,
                  clientOrderId: '6eGYHaJbmJrIS40eoq8ziM',
                  transactTime: 1626946722520
                }
              }
            );
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

        describe('ALPHABTC', () => {
          beforeEach(async () => {
            mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([
              {
                orderId: 123,
                quantity: 11,
                side: 'sell',
                symbol: 'ALPHABTC',
                type: 'MARKET'
              }
            ]);
            mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
              account: 'info'
            });

            binanceMock.client.order = jest.fn().mockResolvedValue({
              symbol: 'ALPHABTC',
              orderId: 2701762317,
              orderListId: -1,
              clientOrderId: '6eGYHaJbmJrIS40eoq8ziM',
              transactTime: 1626946722520
            });

            jest.mock('../../../trailingTradeHelper/common', () => ({
              getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
              isExceedAPILimit: mockIsExceedAPILimit,
              disableAction: mockDisableAction,
              getAPILimit: mockGetAPILimit,
              getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol
            }));

            jest.mock('../../../trailingTradeHelper/configuration', () => ({
              saveSymbolGridTrade: mockSaveSymbolGridTrade
            }));

            const step = require('../place-sell-stop-loss-order');

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
                buy: {
                  gridTrade: [
                    {
                      executed: true,
                      executedOrder: {
                        symbol: 'ALPHABTC',
                        orderId: 2792607,
                        cummulativeQuoteQty: '14.97195000',
                        status: 'FILLED',
                        type: 'STOP_LOSS_LIMIT',
                        side: 'BUY'
                      }
                    }
                  ]
                },
                sell: {
                  enabled: true,
                  gridTrade: [
                    {
                      executed: true,
                      executedOrder: {
                        symbol: 'ALPHABTC',
                        orderId: 2792607,
                        cummulativeQuoteQty: '14.97195000',
                        status: 'FILLED',
                        type: 'STOP_LOSS_LIMIT',
                        side: 'SELL'
                      }
                    }
                  ],
                  stopLoss: {
                    orderType: 'market',
                    disableBuyMinutes: 60
                  }
                }
              },
              action: 'sell-stop-loss',
              baseAssetBalance: { free: 12 },
              sell: {
                currentPrice: 0.00003771,
                openOrders: []
              },
              canDisable: false
            };

            result = await step.execute(loggerMock, rawData);
          });

          it('triggers binance.client.order', () => {
            expect(binanceMock.client.order).toHaveBeenCalledWith({
              quantity: 11,
              side: 'sell',
              symbol: 'ALPHABTC',
              type: 'MARKET'
            });
          });

          it('does not trigger disableAction', () => {
            expect(mockDisableAction).not.toHaveBeenCalled();
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

          it('triggers saveSymbolGridTrade', () => {
            expect(mockSaveSymbolGridTrade).toHaveBeenCalledWith(
              loggerMock,
              'ALPHABTC',
              {
                buy: [
                  {
                    executed: true,
                    executedOrder: {
                      symbol: 'ALPHABTC',
                      orderId: 2792607,
                      cummulativeQuoteQty: '14.97195000',
                      status: 'FILLED',
                      type: 'STOP_LOSS_LIMIT',
                      side: 'BUY'
                    }
                  }
                ],
                sell: [
                  {
                    executed: true,
                    executedOrder: {
                      symbol: 'ALPHABTC',
                      orderId: 2792607,
                      cummulativeQuoteQty: '14.97195000',
                      status: 'FILLED',
                      type: 'STOP_LOSS_LIMIT',
                      side: 'SELL'
                    }
                  }
                ],
                stopLoss: {
                  symbol: 'ALPHABTC',
                  orderId: 2701762317,
                  orderListId: -1,
                  clientOrderId: '6eGYHaJbmJrIS40eoq8ziM',
                  transactTime: 1626946722520
                }
              }
            );
          });

          it('retruns expected value', () => {
            expect(result).toStrictEqual({
              ...rawData,
              ...{
                openOrders: [
                  {
                    orderId: 123,
                    quantity: 11,
                    side: 'sell',
                    symbol: 'ALPHABTC',
                    type: 'MARKET'
                  }
                ],
                sell: {
                  currentPrice: 0.00003771,
                  openOrders: [
                    {
                      orderId: 123,
                      quantity: 11,
                      side: 'sell',
                      symbol: 'ALPHABTC',
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

        describe('BTCBRL', () => {
          beforeEach(async () => {
            mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([
              {
                orderId: 123,
                quantity: 0.0999,
                side: 'sell',
                symbol: 'BTCBRL',
                type: 'MARKET'
              }
            ]);
            mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
              account: 'info'
            });

            binanceMock.client.order = jest.fn().mockResolvedValue({
              symbol: 'BTCBRL',
              orderId: 2701762317,
              orderListId: -1,
              clientOrderId: '6eGYHaJbmJrIS40eoq8ziM',
              transactTime: 1626946722520
            });

            jest.mock('../../../trailingTradeHelper/common', () => ({
              getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
              isExceedAPILimit: mockIsExceedAPILimit,
              disableAction: mockDisableAction,
              getAPILimit: mockGetAPILimit,
              getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol
            }));

            jest.mock('../../../trailingTradeHelper/configuration', () => ({
              saveSymbolGridTrade: mockSaveSymbolGridTrade
            }));

            const step = require('../place-sell-stop-loss-order');

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
                buy: {
                  gridTrade: [
                    {
                      executed: true,
                      executedOrder: {
                        symbol: 'BTCBRL',
                        orderId: 2792607,
                        cummulativeQuoteQty: '14.97195000',
                        status: 'FILLED',
                        type: 'STOP_LOSS_LIMIT',
                        side: 'BUY'
                      }
                    }
                  ]
                },
                sell: {
                  enabled: true,
                  gridTrade: [
                    {
                      executed: true,
                      executedOrder: {
                        symbol: 'BTCBRL',
                        orderId: 2792607,
                        cummulativeQuoteQty: '14.97195000',
                        status: 'FILLED',
                        type: 'STOP_LOSS_LIMIT',
                        side: 'SELL'
                      }
                    }
                  ],
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
              },
              canDisable: false
            };

            result = await step.execute(loggerMock, rawData);
          });

          it('triggers binance.client.order', () => {
            expect(binanceMock.client.order).toHaveBeenCalledWith({
              quantity: 0.0999,
              side: 'sell',
              symbol: 'BTCBRL',
              type: 'MARKET'
            });
          });

          it('does not trigger disableAction', () => {
            expect(mockDisableAction).not.toHaveBeenCalled();
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

          it('triggers saveSymbolGridTrade', () => {
            expect(mockSaveSymbolGridTrade).toHaveBeenCalledWith(
              loggerMock,
              'BTCBRL',
              {
                buy: [
                  {
                    executed: true,
                    executedOrder: {
                      symbol: 'BTCBRL',
                      orderId: 2792607,
                      cummulativeQuoteQty: '14.97195000',
                      status: 'FILLED',
                      type: 'STOP_LOSS_LIMIT',
                      side: 'BUY'
                    }
                  }
                ],
                sell: [
                  {
                    executed: true,
                    executedOrder: {
                      symbol: 'BTCBRL',
                      orderId: 2792607,
                      cummulativeQuoteQty: '14.97195000',
                      status: 'FILLED',
                      type: 'STOP_LOSS_LIMIT',
                      side: 'SELL'
                    }
                  }
                ],
                stopLoss: {
                  symbol: 'BTCBRL',
                  orderId: 2701762317,
                  orderListId: -1,
                  clientOrderId: '6eGYHaJbmJrIS40eoq8ziM',
                  transactTime: 1626946722520
                }
              }
            );
          });

          it('retruns expected value', () => {
            expect(result).toStrictEqual({
              ...rawData,
              ...{
                openOrders: [
                  {
                    orderId: 123,
                    quantity: 0.0999,
                    side: 'sell',
                    symbol: 'BTCBRL',
                    type: 'MARKET'
                  }
                ],
                sell: {
                  currentPrice: 200,
                  openOrders: [
                    {
                      orderId: 123,
                      quantity: 0.0999,
                      side: 'sell',
                      symbol: 'BTCBRL',
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
});
