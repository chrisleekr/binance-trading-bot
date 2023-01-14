/* eslint-disable global-require */

describe('get-indicators.js', () => {
  let result;
  let rawData;
  let step;

  let cacheMock;
  let loggerMock;
  let mongoMock;

  let mockGetLastBuyPrice;

  describe('execute', () => {
    beforeEach(() => {
      jest.clearAllMocks().resetModules();

      const { cache, logger, mongo } = require('../../../../helpers');
      cacheMock = cache;
      loggerMock = logger;
      mongoMock = mongo;
    });

    describe('with no open orders and no last buy price', () => {
      beforeEach(async () => {
        mockGetLastBuyPrice = jest.fn().mockResolvedValue(null);
        jest.mock('../../../trailingTradeHelper/common', () => ({
          getLastBuyPrice: mockGetLastBuyPrice
        }));

        cacheMock.hget = jest.fn().mockImplementation((hash, key) => {
          if (
            hash === 'trailing-trade-symbols' &&
            key === 'BTCUSDT-latest-candle'
          ) {
            return JSON.stringify({
              symbol: 'BTCUSDT',
              close: '15555.09000000'
            });
          }

          if (hash === 'trailing-trade-tradingview' && key === 'BTCUSDT') {
            return JSON.stringify({
              request: {
                symbol: 'BTCUSDT',
                screener: 'CRYPTO',
                exchange: 'BINANCE',
                interval: '15m'
              },
              result: {
                summary: {
                  RECOMMENDATION: 'SELL',
                  BUY: 4,
                  SELL: 14,
                  NEUTRAL: 8
                }
              }
            });
          }

          return null;
        });

        mongoMock.findAll = jest
          .fn()
          .mockImplementation((_logger, collectionName, _query, _params) => {
            if (collectionName === 'trailing-trade-candles') {
              return [
                {
                  interval: '1h',
                  key: 'BTCUSDT',
                  open: 8990.5,
                  high: 10000,
                  low: 8893.03,
                  close: 9899.05
                },
                {
                  interval: '1h',
                  key: 'BTCUSDT',
                  open: 8666.4,
                  high: 9000.6,
                  low: 8899.03,
                  close: 9000.1
                }
              ];
            }
            return [
              {
                interval: '1d',
                key: 'BTCUSDT',
                open: 8690.5,
                high: 9000,
                low: 8110.04,
                close: 9899.05
              },
              {
                interval: '1d',
                key: 'BTCUSDT',
                open: 7755.66,
                high: 8000,
                low: 7695.6,
                close: 8500
              }
            ];
          });

        step = require('../get-indicators');

        rawData = {
          symbol: 'BTCUSDT',
          symbolInfo: {
            filterMinNotional: { minNotional: '10.000' }
          },
          symbolConfiguration: {
            candles: { limit: '100' },
            buy: {
              currentGridTradeIndex: 0,
              currentGridTrade: {
                triggerPercentage: 1.01,
                limitPercentage: 1.021
              },
              athRestriction: {
                enabled: true,
                restrictionPercentage: 0.9,
                candles: {
                  interval: '1d',
                  limit: 30
                }
              }
            },
            sell: {
              currentGridTrade: {
                triggerPercentage: 1.06,
                limitPercentage: 0.979
              },
              stopLoss: { maxLossPercentage: 0.8 },
              conservativeMode: {
                enabled: false,
                factor: 0.5
              }
            }
          },
          baseAssetBalance: { total: 0.1 },
          openOrders: []
        };

        result = await step.execute(loggerMock, rawData);
      });

      it('triggers getLastBuyPrice', () => {
        expect(mockGetLastBuyPrice).toHaveBeenCalledWith(loggerMock, 'BTCUSDT');
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual({
          symbol: 'BTCUSDT',
          symbolInfo: {
            filterMinNotional: { minNotional: '10.000' }
          },
          symbolConfiguration: {
            candles: { limit: '100' },
            buy: {
              currentGridTradeIndex: 0,
              currentGridTrade: {
                triggerPercentage: 1.01,
                limitPercentage: 1.021
              },
              athRestriction: {
                enabled: true,
                restrictionPercentage: 0.9,
                candles: {
                  interval: '1d',
                  limit: 30
                }
              }
            },
            sell: {
              currentGridTrade: {
                triggerPercentage: 1.06,
                limitPercentage: 0.979
              },
              stopLoss: {
                maxLossPercentage: 0.8
              },
              conservativeMode: {
                enabled: false,
                factor: 0.5
              }
            }
          },
          baseAssetBalance: {
            total: 0.1,
            estimatedValue: 1555.509,
            isLessThanMinNotionalValue: false
          },
          openOrders: [],
          indicators: {
            highestPrice: 10000,
            lowestPrice: 8893.03,
            athPrice: 9000
          },
          lastCandle: {
            symbol: 'BTCUSDT',
            close: '15555.09000000'
          },
          buy: {
            currentPrice: 15555.09,
            limitPrice: 15881.746889999999,
            highestPrice: 10000,
            lowestPrice: 8893.03,
            athPrice: 9000,
            athRestrictionPrice: 8100,
            triggerPrice: 8981.9603,
            difference: 73.18146017634923,
            openOrders: [],
            processMessage: '',
            updatedAt: expect.any(Object)
          },
          sell: {
            currentPrice: 15555.09,
            limitPrice: null,
            lastBuyPrice: null,
            triggerPrice: null,
            difference: null,
            currentProfit: null,
            currentProfitPercentage: null,
            openOrders: [],
            stopLossDifference: null,
            stopLossTriggerPrice: null,
            conservativeModeApplicable: false,
            triggerPercentage: null,
            processMessage: '',
            updatedAt: expect.any(Object)
          },
          tradingView: {
            request: {
              symbol: 'BTCUSDT',
              screener: 'CRYPTO',
              exchange: 'BINANCE',
              interval: '15m'
            },
            result: {
              summary: {
                RECOMMENDATION: 'SELL',
                BUY: 4,
                SELL: 14,
                NEUTRAL: 8
              }
            }
          }
        });
      });
    });

    describe('with disabled ATH restriction', () => {
      beforeEach(async () => {
        mockGetLastBuyPrice = jest.fn().mockResolvedValue(null);
        jest.mock('../../../trailingTradeHelper/common', () => ({
          getLastBuyPrice: mockGetLastBuyPrice
        }));

        cacheMock.hget = jest.fn().mockImplementation((hash, key) => {
          if (
            hash === 'trailing-trade-symbols' &&
            key === 'BTCUSDT-latest-candle'
          ) {
            return JSON.stringify({
              symbol: 'BTCUSDT',
              close: '15555.09000000'
            });
          }

          if (hash === 'trailing-trade-tradingview' && key === 'BTCUSDT') {
            return JSON.stringify({
              request: {
                symbol: 'BTCUSDT',
                screener: 'CRYPTO',
                exchange: 'BINANCE',
                interval: '15m'
              },
              result: {
                summary: {
                  RECOMMENDATION: 'SELL',
                  BUY: 4,
                  SELL: 14,
                  NEUTRAL: 8
                }
              }
            });
          }

          return null;
        });

        mongoMock.findAll = jest
          .fn()
          .mockImplementation((_logger, collectionName, _query, _params) => {
            if (collectionName === 'trailing-trade-candles') {
              return [
                {
                  interval: '1h',
                  key: 'BTCUSDT',
                  open: 8990.5,
                  high: 10000,
                  low: 8893.03,
                  close: 9899.05
                },
                {
                  interval: '1h',
                  key: 'BTCUSDT',
                  open: 8666.4,
                  high: 9000.6,
                  low: 8899.03,
                  close: 9000.1
                }
              ];
            }
            return [
              {
                interval: '1d',
                key: 'BTCUSDT',
                open: 8690.5,
                high: 9000,
                low: 8110.04,
                close: 9899.05
              },
              {
                interval: '1d',
                key: 'BTCUSDT',
                open: 7755.66,
                high: 8000,
                low: 7695.6,
                close: 8500
              }
            ];
          });

        step = require('../get-indicators');

        rawData = {
          symbol: 'BTCUSDT',
          symbolInfo: {
            filterMinNotional: { minNotional: '10.000' }
          },
          symbolConfiguration: {
            candles: { limit: '100' },
            buy: {
              currentGridTradeIndex: 0,
              currentGridTrade: {
                triggerPercentage: 1.01,
                limitPercentage: 1.021
              },
              athRestriction: {
                enabled: false,
                restrictionPercentage: 0.9,
                candles: {
                  interval: '1d',
                  limit: 30
                }
              }
            },
            sell: {
              currentGridTrade: {
                triggerPercentage: 1.06,
                limitPercentage: 0.979
              },
              stopLoss: { maxLossPercentage: 0.8 },
              conservativeMode: {
                enabled: false,
                factor: 0.5
              }
            }
          },
          baseAssetBalance: { total: 0.1 },
          openOrders: []
        };

        result = await step.execute(loggerMock, rawData);
      });

      it('triggers getLastBuyPrice', () => {
        expect(mockGetLastBuyPrice).toHaveBeenCalledWith(loggerMock, 'BTCUSDT');
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual({
          symbol: 'BTCUSDT',
          symbolInfo: {
            filterMinNotional: { minNotional: '10.000' }
          },
          symbolConfiguration: {
            candles: { limit: '100' },
            buy: {
              currentGridTradeIndex: 0,
              currentGridTrade: {
                triggerPercentage: 1.01,
                limitPercentage: 1.021
              },
              athRestriction: {
                enabled: false,
                restrictionPercentage: 0.9,
                candles: {
                  interval: '1d',
                  limit: 30
                }
              }
            },
            sell: {
              currentGridTrade: {
                triggerPercentage: 1.06,
                limitPercentage: 0.979
              },
              stopLoss: {
                maxLossPercentage: 0.8
              },
              conservativeMode: {
                enabled: false,
                factor: 0.5
              }
            }
          },
          baseAssetBalance: {
            total: 0.1,
            estimatedValue: 1555.509,
            isLessThanMinNotionalValue: false
          },
          openOrders: [],
          indicators: {
            highestPrice: 10000,
            lowestPrice: 8893.03,
            athPrice: null
          },
          lastCandle: {
            symbol: 'BTCUSDT',
            close: '15555.09000000'
          },
          buy: {
            currentPrice: 15555.09,
            limitPrice: 15881.746889999999,
            highestPrice: 10000,
            lowestPrice: 8893.03,
            athPrice: null,
            athRestrictionPrice: null,
            triggerPrice: 8981.9603,
            difference: 73.18146017634923,
            openOrders: [],
            processMessage: '',
            updatedAt: expect.any(Object)
          },
          sell: {
            currentPrice: 15555.09,
            limitPrice: null,
            lastBuyPrice: null,
            triggerPrice: null,
            difference: null,
            currentProfit: null,
            currentProfitPercentage: null,
            openOrders: [],
            stopLossDifference: null,
            stopLossTriggerPrice: null,
            conservativeModeApplicable: false,
            triggerPercentage: null,
            processMessage: '',
            updatedAt: expect.any(Object)
          },
          tradingView: {
            request: {
              symbol: 'BTCUSDT',
              screener: 'CRYPTO',
              exchange: 'BINANCE',
              interval: '15m'
            },
            result: {
              summary: {
                RECOMMENDATION: 'SELL',
                BUY: 4,
                SELL: 14,
                NEUTRAL: 8
              }
            }
          }
        });
      });
    });

    describe('with no open orders but has last buy price', () => {
      beforeEach(() => {
        mockGetLastBuyPrice = jest
          .fn()
          .mockResolvedValue({ lastBuyPrice: 9000, quantity: 1 });
        jest.mock('../../../trailingTradeHelper/common', () => ({
          getLastBuyPrice: mockGetLastBuyPrice
        }));
        cacheMock.hget = jest.fn().mockImplementation((hash, key) => {
          if (
            hash === 'trailing-trade-symbols' &&
            key === 'BTCUSDT-latest-candle'
          ) {
            return JSON.stringify({
              symbol: 'BTCUSDT',
              close: '15555.09000000'
            });
          }

          if (hash === 'trailing-trade-tradingview' && key === 'BTCUSDT') {
            return JSON.stringify({
              request: {
                symbol: 'BTCUSDT',
                screener: 'CRYPTO',
                exchange: 'BINANCE',
                interval: '15m'
              },
              result: {
                summary: {
                  RECOMMENDATION: 'SELL',
                  BUY: 4,
                  SELL: 14,
                  NEUTRAL: 8
                }
              }
            });
          }

          return null;
        });

        mongoMock.findAll = jest
          .fn()
          .mockImplementation((_logger, collectionName, _query, _params) => {
            if (collectionName === 'trailing-trade-candles') {
              return [
                {
                  interval: '1h',
                  key: 'BTCUSDT',
                  open: 8990.5,
                  high: 10000,
                  low: 8893.03,
                  close: 9899.05
                },
                {
                  interval: '1h',
                  key: 'BTCUSDT',
                  open: 8666.4,
                  high: 9000.6,
                  low: 8899.03,
                  close: 9000.1
                }
              ];
            }
            return [
              {
                interval: '1d',
                key: 'BTCUSDT',
                open: 8690.5,
                high: 9000,
                low: 8110.04,
                close: 9899.05
              },
              {
                interval: '1d',
                key: 'BTCUSDT',
                open: 7755.66,
                high: 8000,
                low: 7695.6,
                close: 8500
              }
            ];
          });
      });

      describe('when buy grid trade index is null', () => {
        beforeEach(async () => {
          step = require('../get-indicators');

          rawData = {
            symbol: 'BTCUSDT',
            symbolInfo: {
              filterMinNotional: { minNotional: '10.000' }
            },
            symbolConfiguration: {
              candles: { limit: '100' },
              buy: {
                currentGridTradeIndex: -1,
                currentGridTrade: null,
                athRestriction: {
                  enabled: true,
                  restrictionPercentage: 0.9,
                  candles: {
                    interval: '1d',
                    limit: 30
                  }
                }
              },
              sell: {
                currentGridTrade: null,
                stopLoss: { maxLossPercentage: 0.8 },
                conservativeMode: {
                  enabled: false,
                  factor: 0.5
                }
              }
            },
            baseAssetBalance: { total: 0.1 },
            openOrders: []
          };

          result = await step.execute(loggerMock, rawData);
        });

        it('triggers getLastBuyPrice', () => {
          expect(mockGetLastBuyPrice).toHaveBeenCalledWith(
            loggerMock,
            'BTCUSDT'
          );
        });

        it('triggers expected value', () => {
          expect(result).toStrictEqual({
            symbol: 'BTCUSDT',
            symbolInfo: {
              filterMinNotional: { minNotional: '10.000' }
            },
            symbolConfiguration: {
              candles: { limit: '100' },
              buy: {
                currentGridTradeIndex: -1,
                currentGridTrade: null,
                athRestriction: {
                  enabled: true,
                  restrictionPercentage: 0.9,
                  candles: {
                    interval: '1d',
                    limit: 30
                  }
                }
              },
              sell: {
                currentGridTrade: null,
                stopLoss: {
                  maxLossPercentage: 0.8
                },
                conservativeMode: {
                  enabled: false,
                  factor: 0.5
                }
              }
            },
            baseAssetBalance: {
              total: 0.1,
              estimatedValue: 1555.509,
              isLessThanMinNotionalValue: false
            },
            openOrders: [],
            indicators: {
              highestPrice: 10000,
              lowestPrice: 8893.03,
              athPrice: 9000
            },
            lastCandle: {
              symbol: 'BTCUSDT',
              close: '15555.09000000'
            },
            buy: {
              currentPrice: 15555.09,
              limitPrice: null,
              highestPrice: 10000,
              lowestPrice: 8893.03,
              athPrice: 9000,
              athRestrictionPrice: 8100,
              triggerPrice: null,
              difference: null,
              openOrders: [],
              processMessage: '',
              updatedAt: expect.any(Object)
            },
            sell: {
              currentPrice: 15555.09,
              limitPrice: null,
              lastBuyPrice: 9000,
              triggerPrice: null,
              difference: null,
              currentProfit: 655.509,
              currentProfitPercentage: 72.83433333333333,
              stopLossDifference: 53.712900407519335,
              stopLossTriggerPrice: 7200,
              conservativeModeApplicable: false,
              triggerPercentage: null,
              openOrders: [],
              processMessage: '',
              updatedAt: expect.any(Object)
            },
            tradingView: {
              request: {
                symbol: 'BTCUSDT',
                screener: 'CRYPTO',
                exchange: 'BINANCE',
                interval: '15m'
              },
              result: {
                summary: {
                  RECOMMENDATION: 'SELL',
                  BUY: 4,
                  SELL: 14,
                  NEUTRAL: 8
                }
              }
            }
          });
        });
      });

      describe('when buy grid trade index is 0', () => {
        beforeEach(async () => {
          step = require('../get-indicators');

          rawData = {
            symbol: 'BTCUSDT',
            symbolInfo: {
              filterMinNotional: { minNotional: '10.000' }
            },
            symbolConfiguration: {
              candles: { limit: '100' },
              buy: {
                currentGridTradeIndex: 0,
                currentGridTrade: {
                  triggerPercentage: 1.01,
                  limitPercentage: 1.021
                },
                athRestriction: {
                  enabled: true,
                  restrictionPercentage: 0.9,
                  candles: {
                    interval: '1d',
                    limit: 30
                  }
                }
              },
              sell: {
                currentGridTrade: {
                  triggerPercentage: 1.06,
                  limitPercentage: 0.979
                },
                stopLoss: { maxLossPercentage: 0.8 },
                conservativeMode: {
                  enabled: false,
                  factor: 0.5
                }
              }
            },
            baseAssetBalance: { total: 0.1 },
            openOrders: []
          };

          result = await step.execute(loggerMock, rawData);
        });

        it('triggers getLastBuyPrice', () => {
          expect(mockGetLastBuyPrice).toHaveBeenCalledWith(
            loggerMock,
            'BTCUSDT'
          );
        });

        it('triggers expected value', () => {
          expect(result).toStrictEqual({
            symbol: 'BTCUSDT',
            symbolInfo: {
              filterMinNotional: { minNotional: '10.000' }
            },
            symbolConfiguration: {
              candles: { limit: '100' },
              buy: {
                currentGridTradeIndex: 0,
                currentGridTrade: {
                  triggerPercentage: 1.01,
                  limitPercentage: 1.021
                },
                athRestriction: {
                  enabled: true,
                  restrictionPercentage: 0.9,
                  candles: {
                    interval: '1d',
                    limit: 30
                  }
                }
              },
              sell: {
                currentGridTrade: {
                  triggerPercentage: 1.06,
                  limitPercentage: 0.979
                },
                stopLoss: {
                  maxLossPercentage: 0.8
                },
                conservativeMode: {
                  enabled: false,
                  factor: 0.5
                }
              }
            },
            baseAssetBalance: {
              total: 0.1,
              estimatedValue: 1555.509,
              isLessThanMinNotionalValue: false
            },
            openOrders: [],
            indicators: {
              highestPrice: 10000,
              lowestPrice: 8893.03,
              athPrice: 9000
            },
            lastCandle: {
              symbol: 'BTCUSDT',
              close: '15555.09000000'
            },
            buy: {
              currentPrice: 15555.09,
              limitPrice: 15881.746889999999,
              highestPrice: 10000,
              lowestPrice: 8893.03,
              athPrice: 9000,
              athRestrictionPrice: 8100,
              triggerPrice: 8981.9603,
              difference: 73.18146017634923,
              openOrders: [],
              processMessage: '',
              updatedAt: expect.any(Object)
            },
            sell: {
              currentPrice: 15555.09,
              limitPrice: 15228.43311,
              lastBuyPrice: 9000,
              triggerPrice: 9540,
              difference: 38.669593039963125,
              currentProfit: 655.509,
              currentProfitPercentage: 72.83433333333333,
              stopLossDifference: 53.712900407519335,
              stopLossTriggerPrice: 7200,
              openOrders: [],
              conservativeModeApplicable: false,
              triggerPercentage: 1.06,
              processMessage: '',
              updatedAt: expect.any(Object)
            },
            tradingView: {
              request: {
                symbol: 'BTCUSDT',
                screener: 'CRYPTO',
                exchange: 'BINANCE',
                interval: '15m'
              },
              result: {
                summary: {
                  RECOMMENDATION: 'SELL',
                  BUY: 4,
                  SELL: 14,
                  NEUTRAL: 8
                }
              }
            }
          });
        });
      });

      describe('when buy grid trade index is 1', () => {
        beforeEach(async () => {
          step = require('../get-indicators');

          rawData = {
            symbol: 'BTCUSDT',
            symbolInfo: {
              filterMinNotional: { minNotional: '10.000' }
            },
            symbolConfiguration: {
              candles: { limit: '100' },
              buy: {
                currentGridTradeIndex: 1,
                currentGridTrade: {
                  triggerPercentage: 1.01,
                  limitPercentage: 1.021
                },
                athRestriction: {
                  enabled: true,
                  restrictionPercentage: 0.9,
                  candles: {
                    interval: '1d',
                    limit: 30
                  }
                }
              },
              sell: {
                currentGridTrade: {
                  triggerPercentage: 1.06,
                  limitPercentage: 0.979
                },
                stopLoss: { maxLossPercentage: 0.8 },
                conservativeMode: {
                  enabled: false,
                  factor: 0.5
                }
              }
            },
            baseAssetBalance: { total: 0.1 },
            openOrders: []
          };

          result = await step.execute(loggerMock, rawData);
        });

        it('triggers getLastBuyPrice', () => {
          expect(mockGetLastBuyPrice).toHaveBeenCalledWith(
            loggerMock,
            'BTCUSDT'
          );
        });

        it('triggers expected value', () => {
          expect(result).toStrictEqual({
            symbol: 'BTCUSDT',
            symbolInfo: {
              filterMinNotional: { minNotional: '10.000' }
            },
            symbolConfiguration: {
              candles: { limit: '100' },
              buy: {
                currentGridTradeIndex: 1,
                currentGridTrade: {
                  triggerPercentage: 1.01,
                  limitPercentage: 1.021
                },
                athRestriction: {
                  enabled: true,
                  restrictionPercentage: 0.9,
                  candles: {
                    interval: '1d',
                    limit: 30
                  }
                }
              },
              sell: {
                currentGridTrade: {
                  triggerPercentage: 1.06,
                  limitPercentage: 0.979
                },
                stopLoss: {
                  maxLossPercentage: 0.8
                },
                conservativeMode: {
                  enabled: false,
                  factor: 0.5
                }
              }
            },
            baseAssetBalance: {
              total: 0.1,
              estimatedValue: 1555.509,
              isLessThanMinNotionalValue: false
            },
            openOrders: [],
            indicators: {
              highestPrice: 10000,
              lowestPrice: 8893.03,
              athPrice: 9000
            },
            lastCandle: {
              symbol: 'BTCUSDT',
              close: '15555.09000000'
            },
            buy: {
              currentPrice: 15555.09,
              limitPrice: 15881.746889999999,
              highestPrice: 10000,
              lowestPrice: 8893.03,
              athPrice: 9000,
              athRestrictionPrice: 8100,
              triggerPrice: 9090,
              difference: 71.12310231023102,
              openOrders: [],
              processMessage: '',
              updatedAt: expect.any(Object)
            },
            sell: {
              currentPrice: 15555.09,
              limitPrice: 15228.43311,
              lastBuyPrice: 9000,
              triggerPrice: 9540,
              difference: 38.669593039963125,
              currentProfit: 655.509,
              currentProfitPercentage: 72.83433333333333,
              stopLossDifference: 53.712900407519335,
              stopLossTriggerPrice: 7200,
              openOrders: [],
              conservativeModeApplicable: false,
              triggerPercentage: 1.06,
              processMessage: '',
              updatedAt: expect.any(Object)
            },
            tradingView: {
              request: {
                symbol: 'BTCUSDT',
                screener: 'CRYPTO',
                exchange: 'BINANCE',
                interval: '15m'
              },
              result: {
                summary: {
                  RECOMMENDATION: 'SELL',
                  BUY: 4,
                  SELL: 14,
                  NEUTRAL: 8
                }
              }
            }
          });
        });
      });

      describe('when buy grid trade index is 1 and conservative mode enabled', () => {
        beforeEach(async () => {
          step = require('../get-indicators');

          rawData = {
            symbol: 'BTCUSDT',
            symbolInfo: {
              filterMinNotional: { minNotional: '10.000' }
            },
            symbolConfiguration: {
              candles: { limit: '100' },
              buy: {
                currentGridTradeIndex: 1,
                currentGridTrade: {
                  triggerPercentage: 1.01,
                  limitPercentage: 1.021
                },
                athRestriction: {
                  enabled: true,
                  restrictionPercentage: 0.9,
                  candles: {
                    interval: '1d',
                    limit: 30
                  }
                },
                gridTrade: [
                  {
                    executed: true
                  },
                  {
                    executed: true
                  }
                ]
              },
              sell: {
                currentGridTrade: {
                  triggerPercentage: 1.06,
                  limitPercentage: 0.979
                },
                stopLoss: { maxLossPercentage: 0.8 },
                conservativeMode: {
                  enabled: true,
                  factor: 0.5
                }
              }
            },
            baseAssetBalance: { total: 0.1 },
            openOrders: []
          };

          result = await step.execute(loggerMock, rawData);
        });

        it('triggers getLastBuyPrice', () => {
          expect(mockGetLastBuyPrice).toHaveBeenCalledWith(
            loggerMock,
            'BTCUSDT'
          );
        });

        it('triggers expected value', () => {
          expect(result).toStrictEqual({
            symbol: 'BTCUSDT',
            symbolInfo: {
              filterMinNotional: { minNotional: '10.000' }
            },
            symbolConfiguration: {
              candles: { limit: '100' },
              buy: {
                currentGridTradeIndex: 1,
                currentGridTrade: {
                  triggerPercentage: 1.01,
                  limitPercentage: 1.021
                },
                athRestriction: {
                  enabled: true,
                  restrictionPercentage: 0.9,
                  candles: {
                    interval: '1d',
                    limit: 30
                  }
                },
                gridTrade: [
                  {
                    executed: true
                  },
                  {
                    executed: true
                  }
                ]
              },
              sell: {
                currentGridTrade: {
                  triggerPercentage: 1.06,
                  limitPercentage: 0.979
                },
                stopLoss: {
                  maxLossPercentage: 0.8
                },
                conservativeMode: {
                  enabled: true,
                  factor: 0.5
                }
              }
            },
            baseAssetBalance: {
              total: 0.1,
              estimatedValue: 1555.509,
              isLessThanMinNotionalValue: false
            },
            openOrders: [],
            indicators: {
              highestPrice: 10000,
              lowestPrice: 8893.03,
              athPrice: 9000
            },
            lastCandle: {
              symbol: 'BTCUSDT',
              close: '15555.09000000'
            },
            buy: {
              currentPrice: 15555.09,
              limitPrice: 15881.746889999999,
              highestPrice: 10000,
              lowestPrice: 8893.03,
              athPrice: 9000,
              athRestrictionPrice: 8100,
              triggerPrice: 9090,
              difference: 71.12310231023102,
              openOrders: [],
              processMessage: '',
              updatedAt: expect.any(Object)
            },
            sell: {
              currentPrice: 15555.09,
              limitPrice: 15228.43311,
              lastBuyPrice: 9000,
              triggerPrice: 9270,
              difference: 40.40535927468115,
              currentProfit: 655.509,
              currentProfitPercentage: 72.83433333333333,
              stopLossDifference: 53.712900407519335,
              stopLossTriggerPrice: 7200,
              openOrders: [],
              conservativeModeApplicable: true,
              triggerPercentage: 1.03,
              processMessage: '',
              updatedAt: expect.any(Object)
            },
            tradingView: {
              request: {
                symbol: 'BTCUSDT',
                screener: 'CRYPTO',
                exchange: 'BINANCE',
                interval: '15m'
              },
              result: {
                summary: {
                  RECOMMENDATION: 'SELL',
                  BUY: 4,
                  SELL: 14,
                  NEUTRAL: 8
                }
              }
            }
          });
        });
      });
    });

    describe('with open orders and has last buy price', () => {
      beforeEach(() => {
        mockGetLastBuyPrice = jest
          .fn()
          .mockResolvedValue({ lastBuyPrice: 9000, quantity: 1 });
        jest.mock('../../../trailingTradeHelper/common', () => ({
          getLastBuyPrice: mockGetLastBuyPrice
        }));

        cacheMock.hget = jest.fn().mockImplementation((hash, key) => {
          if (
            hash === 'trailing-trade-symbols' &&
            key === 'BTCUSDT-latest-candle'
          ) {
            return JSON.stringify({
              symbol: 'BTCUSDT',
              close: '15555.09000000'
            });
          }

          if (hash === 'trailing-trade-tradingview' && key === 'BTCUSDT') {
            return JSON.stringify({
              request: {
                symbol: 'BTCUSDT',
                screener: 'CRYPTO',
                exchange: 'BINANCE',
                interval: '15m'
              },
              result: {
                summary: {
                  RECOMMENDATION: 'SELL',
                  BUY: 4,
                  SELL: 14,
                  NEUTRAL: 8
                }
              }
            });
          }

          return null;
        });

        mongoMock.findAll = jest
          .fn()
          .mockImplementation((_logger, collectionName, _query, _params) => {
            if (collectionName === 'trailing-trade-candles') {
              return [
                {
                  interval: '1h',
                  key: 'BTCUSDT',
                  open: 8990.5,
                  high: 10000,
                  low: 8893.03,
                  close: 9899.05
                },
                {
                  interval: '1h',
                  key: 'BTCUSDT',
                  open: 8666.4,
                  high: 9000.6,
                  low: 8899.03,
                  close: 9000.1
                }
              ];
            }
            return [
              {
                interval: '1d',
                key: 'BTCUSDT',
                open: 8690.5,
                high: 9000,
                low: 8110.04,
                close: 9899.05
              },
              {
                interval: '1d',
                key: 'BTCUSDT',
                open: 7755.66,
                high: 8000,
                low: 7695.6,
                close: 8500
              }
            ];
          });
      });

      describe('when buy grid trade index is null', () => {
        beforeEach(async () => {
          step = require('../get-indicators');

          rawData = {
            symbol: 'BTCUSDT',
            symbolInfo: {
              filterMinNotional: { minNotional: '10.000' }
            },
            symbolConfiguration: {
              candles: { limit: '100' },
              buy: {
                currentGridTradeIndex: -1,
                currentGridTrade: null,
                athRestriction: {
                  enabled: true,
                  restrictionPercentage: 0.9,
                  candles: {
                    interval: '1d',
                    limit: 30
                  }
                }
              },
              sell: {
                currentGridTrade: null,
                stopLoss: { maxLossPercentage: 0.8 },
                conservativeMode: {
                  enabled: false,
                  factor: 0.5
                }
              }
            },
            baseAssetBalance: { total: 0.1 },
            openOrders: [
              {
                orderId: 1,
                symbol: 'BTCUSDT',
                type: 'LIMIT',
                side: 'BUY',
                price: '13000.000',
                origQty: '0.005',
                time: 1615465601162
              },
              {
                orderId: 2,
                symbol: 'BTCUSDT',
                type: 'STOP_LOSS_LIMIT',
                side: 'BUY',
                price: '16100.000',
                origQty: '0.005',
                stopPrice: '16000.000',
                time: 1615465601162
              },
              {
                orderId: 3,
                symbol: 'BTCUSDT',
                type: 'STOP_LOSS_LIMIT',
                side: 'SELL',
                price: '15900.000',
                origQty: '0.005',
                stopPrice: '16000.000',
                time: 1615465601162
              }
            ]
          };

          result = await step.execute(loggerMock, rawData);
        });

        it('triggers getLastBuyPrice', () => {
          expect(mockGetLastBuyPrice).toHaveBeenCalledWith(
            loggerMock,
            'BTCUSDT'
          );
        });

        it('triggers expected value', () => {
          expect(result).toStrictEqual({
            symbol: 'BTCUSDT',
            symbolInfo: {
              filterMinNotional: { minNotional: '10.000' }
            },
            symbolConfiguration: {
              candles: { limit: '100' },
              buy: {
                currentGridTradeIndex: -1,
                currentGridTrade: null,
                athRestriction: {
                  enabled: true,
                  restrictionPercentage: 0.9,
                  candles: {
                    interval: '1d',
                    limit: 30
                  }
                }
              },
              sell: {
                currentGridTrade: null,
                stopLoss: {
                  maxLossPercentage: 0.8
                },
                conservativeMode: {
                  enabled: false,
                  factor: 0.5
                }
              }
            },
            baseAssetBalance: {
              total: 0.1,
              estimatedValue: 1555.509,
              isLessThanMinNotionalValue: false
            },
            openOrders: [
              {
                orderId: 1,
                symbol: 'BTCUSDT',
                type: 'LIMIT',
                side: 'BUY',
                price: '13000.000',
                origQty: '0.005',
                time: 1615465601162,
                currentPrice: 15555.09,
                updatedAt: expect.any(Object)
              },
              {
                orderId: 2,
                symbol: 'BTCUSDT',
                type: 'STOP_LOSS_LIMIT',
                side: 'BUY',
                price: '16100.000',
                origQty: '0.005',
                stopPrice: '16000.000',
                time: 1615465601162,
                currentPrice: 15555.09,
                differenceToCancel: null,
                differenceToExecute: -2.86022131662369,
                updatedAt: expect.any(Object)
              },
              {
                orderId: 3,
                symbol: 'BTCUSDT',
                type: 'STOP_LOSS_LIMIT',
                side: 'SELL',
                price: '15900.000',
                origQty: '0.005',
                stopPrice: '16000.000',
                time: 1615465601162,
                currentPrice: 15555.09,
                differenceToCancel: null,
                differenceToExecute: -2.86022131662369,
                minimumProfit: 34.5,
                minimumProfitPercentage: 76.66666666666666,
                updatedAt: expect.any(Object)
              }
            ],
            indicators: {
              highestPrice: 10000,
              lowestPrice: 8893.03,
              athPrice: 9000
            },
            lastCandle: {
              symbol: 'BTCUSDT',
              close: '15555.09000000'
            },
            buy: {
              currentPrice: 15555.09,
              limitPrice: null,
              highestPrice: 10000,
              lowestPrice: 8893.03,
              athPrice: 9000,
              athRestrictionPrice: 8100,
              triggerPrice: null,
              difference: null,
              openOrders: [
                {
                  orderId: 1,
                  symbol: 'BTCUSDT',
                  type: 'LIMIT',
                  side: 'BUY',
                  price: '13000.000',
                  origQty: '0.005',
                  time: 1615465601162,
                  currentPrice: 15555.09,
                  updatedAt: expect.any(Object)
                },
                {
                  orderId: 2,
                  symbol: 'BTCUSDT',
                  type: 'STOP_LOSS_LIMIT',
                  side: 'BUY',
                  price: '16100.000',
                  origQty: '0.005',
                  stopPrice: '16000.000',
                  time: 1615465601162,
                  currentPrice: 15555.09,
                  differenceToCancel: null,
                  differenceToExecute: -2.86022131662369,
                  updatedAt: expect.any(Object)
                }
              ],
              processMessage: '',
              updatedAt: expect.any(Object)
            },
            sell: {
              currentPrice: 15555.09,
              limitPrice: null,
              lastBuyPrice: 9000,
              triggerPrice: null,
              difference: null,
              currentProfit: 655.509,
              currentProfitPercentage: 72.83433333333333,
              stopLossDifference: 53.712900407519335,
              stopLossTriggerPrice: 7200,
              openOrders: [
                {
                  orderId: 3,
                  symbol: 'BTCUSDT',
                  type: 'STOP_LOSS_LIMIT',
                  side: 'SELL',
                  price: '15900.000',
                  origQty: '0.005',
                  stopPrice: '16000.000',
                  time: 1615465601162,
                  currentPrice: 15555.09,
                  differenceToCancel: null,
                  differenceToExecute: -2.86022131662369,
                  minimumProfit: 34.5,
                  minimumProfitPercentage: 76.66666666666666,
                  updatedAt: expect.any(Object)
                }
              ],
              conservativeModeApplicable: false,
              triggerPercentage: null,
              processMessage: '',
              updatedAt: expect.any(Object)
            },
            tradingView: {
              request: {
                symbol: 'BTCUSDT',
                screener: 'CRYPTO',
                exchange: 'BINANCE',
                interval: '15m'
              },
              result: {
                summary: {
                  RECOMMENDATION: 'SELL',
                  BUY: 4,
                  SELL: 14,
                  NEUTRAL: 8
                }
              }
            }
          });
        });
      });

      describe('when buy grid trade index is 0', () => {
        beforeEach(async () => {
          step = require('../get-indicators');

          rawData = {
            symbol: 'BTCUSDT',
            symbolInfo: {
              filterMinNotional: { minNotional: '10.000' }
            },
            symbolConfiguration: {
              candles: { limit: '100' },
              buy: {
                currentGridTradeIndex: 0,
                currentGridTrade: {
                  triggerPercentage: 1.01,
                  limitPercentage: 1.021
                },
                athRestriction: {
                  enabled: true,
                  restrictionPercentage: 0.9,
                  candles: {
                    interval: '1d',
                    limit: 30
                  }
                }
              },
              sell: {
                currentGridTrade: {
                  triggerPercentage: 1.06,
                  limitPercentage: 0.979
                },
                stopLoss: { maxLossPercentage: 0.8 },
                conservativeMode: {
                  enabled: false,
                  factor: 0.5
                }
              }
            },
            baseAssetBalance: { total: 0.1 },
            openOrders: [
              {
                orderId: 1,
                symbol: 'BTCUSDT',
                type: 'LIMIT',
                side: 'BUY',
                price: '13000.000',
                origQty: '0.005',
                time: 1615465601162
              },
              {
                orderId: 2,
                symbol: 'BTCUSDT',
                type: 'STOP_LOSS_LIMIT',
                side: 'BUY',
                price: '16000.000',
                origQty: '0.005',
                stopPrice: '16100.000',
                time: 1615465601162
              },
              {
                orderId: 3,
                symbol: 'BTCUSDT',
                type: 'STOP_LOSS_LIMIT',
                side: 'SELL',
                price: '16000.000',
                origQty: '0.005',
                stopPrice: '15900.000',
                time: 1615465601162
              }
            ]
          };

          result = await step.execute(loggerMock, rawData);
        });

        it('triggers getLastBuyPrice', () => {
          expect(mockGetLastBuyPrice).toHaveBeenCalledWith(
            loggerMock,
            'BTCUSDT'
          );
        });

        it('triggers expected value', () => {
          expect(result).toStrictEqual({
            symbol: 'BTCUSDT',
            symbolInfo: {
              filterMinNotional: { minNotional: '10.000' }
            },
            symbolConfiguration: {
              candles: { limit: '100' },
              buy: {
                currentGridTradeIndex: 0,
                currentGridTrade: {
                  triggerPercentage: 1.01,
                  limitPercentage: 1.021
                },
                athRestriction: {
                  enabled: true,
                  restrictionPercentage: 0.9,
                  candles: {
                    interval: '1d',
                    limit: 30
                  }
                }
              },
              sell: {
                currentGridTrade: {
                  triggerPercentage: 1.06,
                  limitPercentage: 0.979
                },
                stopLoss: {
                  maxLossPercentage: 0.8
                },
                conservativeMode: {
                  enabled: false,
                  factor: 0.5
                }
              }
            },
            baseAssetBalance: {
              total: 0.1,
              estimatedValue: 1555.509,
              isLessThanMinNotionalValue: false
            },
            openOrders: [
              {
                orderId: 1,
                symbol: 'BTCUSDT',
                type: 'LIMIT',
                side: 'BUY',
                price: '13000.000',
                origQty: '0.005',
                time: 1615465601162,
                currentPrice: 15555.09,
                updatedAt: expect.any(Object)
              },
              {
                orderId: 2,
                symbol: 'BTCUSDT',
                type: 'STOP_LOSS_LIMIT',
                side: 'BUY',
                price: '16000.000',
                origQty: '0.005',
                stopPrice: '16100.000',
                time: 1615465601162,
                currentPrice: 15555.09,
                differenceToCancel: -1.37423868741684,
                differenceToExecute: -3.5030976998525976,
                updatedAt: expect.any(Object)
              },
              {
                orderId: 3,
                symbol: 'BTCUSDT',
                type: 'STOP_LOSS_LIMIT',
                side: 'SELL',
                price: '16000.000',
                origQty: '0.005',
                stopPrice: '15900.000',
                time: 1615465601162,
                currentPrice: 15555.09,
                differenceToCancel: -4.40995396669539,
                differenceToExecute: -2.2173449333947826,
                minimumProfit: 35,
                minimumProfitPercentage: 77.77777777777777,
                updatedAt: expect.any(Object)
              }
            ],
            indicators: {
              highestPrice: 10000,
              lowestPrice: 8893.03,
              athPrice: 9000
            },
            lastCandle: {
              symbol: 'BTCUSDT',
              close: '15555.09000000'
            },
            buy: {
              currentPrice: 15555.09,
              limitPrice: 15881.746889999999,
              highestPrice: 10000,
              lowestPrice: 8893.03,
              athPrice: 9000,
              athRestrictionPrice: 8100,
              triggerPrice: 8981.9603,
              difference: 73.18146017634923,
              openOrders: [
                {
                  orderId: 1,
                  symbol: 'BTCUSDT',
                  type: 'LIMIT',
                  side: 'BUY',
                  price: '13000.000',
                  origQty: '0.005',
                  time: 1615465601162,
                  currentPrice: 15555.09,
                  updatedAt: expect.any(Object)
                },
                {
                  orderId: 2,
                  symbol: 'BTCUSDT',
                  type: 'STOP_LOSS_LIMIT',
                  side: 'BUY',
                  price: '16000.000',
                  origQty: '0.005',
                  stopPrice: '16100.000',
                  time: 1615465601162,
                  currentPrice: 15555.09,
                  differenceToCancel: -1.37423868741684,
                  differenceToExecute: -3.5030976998525976,
                  updatedAt: expect.any(Object)
                }
              ],
              processMessage: '',
              updatedAt: expect.any(Object)
            },
            sell: {
              currentPrice: 15555.09,
              limitPrice: 15228.43311,
              lastBuyPrice: 9000,
              triggerPrice: 9540,
              difference: 38.669593039963125,
              currentProfit: 655.509,
              currentProfitPercentage: 72.83433333333333,
              stopLossDifference: 53.712900407519335,
              stopLossTriggerPrice: 7200,
              openOrders: [
                {
                  orderId: 3,
                  symbol: 'BTCUSDT',
                  type: 'STOP_LOSS_LIMIT',
                  side: 'SELL',
                  price: '16000.000',
                  origQty: '0.005',
                  stopPrice: '15900.000',
                  time: 1615465601162,
                  currentPrice: 15555.09,
                  differenceToCancel: -4.40995396669539,
                  differenceToExecute: -2.2173449333947826,
                  minimumProfit: 35,
                  minimumProfitPercentage: 77.77777777777777,
                  updatedAt: expect.any(Object)
                }
              ],
              conservativeModeApplicable: false,
              triggerPercentage: 1.06,
              processMessage: '',
              updatedAt: expect.any(Object)
            },
            tradingView: {
              request: {
                symbol: 'BTCUSDT',
                screener: 'CRYPTO',
                exchange: 'BINANCE',
                interval: '15m'
              },
              result: {
                summary: {
                  RECOMMENDATION: 'SELL',
                  BUY: 4,
                  SELL: 14,
                  NEUTRAL: 8
                }
              }
            }
          });
        });
      });

      describe('when buy grid trade index is 1', () => {
        beforeEach(async () => {
          step = require('../get-indicators');

          rawData = {
            symbol: 'BTCUSDT',
            symbolInfo: {
              filterMinNotional: { minNotional: '10.000' }
            },
            symbolConfiguration: {
              candles: { limit: '100' },
              buy: {
                currentGridTradeIndex: 1,
                currentGridTrade: {
                  triggerPercentage: 1.01,
                  limitPercentage: 1.021
                },
                athRestriction: {
                  enabled: true,
                  restrictionPercentage: 0.9,
                  candles: {
                    interval: '1d',
                    limit: 30
                  }
                }
              },
              sell: {
                currentGridTrade: {
                  triggerPercentage: 1.06,
                  limitPercentage: 0.979
                },
                stopLoss: { maxLossPercentage: 0.8 },
                conservativeMode: {
                  enabled: false,
                  factor: 0.5
                }
              }
            },
            baseAssetBalance: { total: 0.1 },
            openOrders: [
              {
                orderId: 1,
                symbol: 'BTCUSDT',
                type: 'LIMIT',
                side: 'BUY',
                price: '13000.000',
                origQty: '0.005',
                time: 1615465601162
              },
              {
                orderId: 2,
                symbol: 'BTCUSDT',
                type: 'STOP_LOSS_LIMIT',
                side: 'BUY',
                price: '16000.000',
                origQty: '0.005',
                stopPrice: '16100.000',
                time: 1615465601162
              },
              {
                orderId: 3,
                symbol: 'BTCUSDT',
                type: 'STOP_LOSS_LIMIT',
                side: 'SELL',
                price: '16000.000',
                origQty: '0.005',
                stopPrice: '15900.000',
                time: 1615465601162
              }
            ]
          };

          result = await step.execute(loggerMock, rawData);
        });

        it('triggers getLastBuyPrice', () => {
          expect(mockGetLastBuyPrice).toHaveBeenCalledWith(
            loggerMock,
            'BTCUSDT'
          );
        });

        it('triggers expected value', () => {
          expect(result).toStrictEqual({
            symbol: 'BTCUSDT',
            symbolInfo: {
              filterMinNotional: { minNotional: '10.000' }
            },
            symbolConfiguration: {
              candles: { limit: '100' },
              buy: {
                currentGridTradeIndex: 1,
                currentGridTrade: {
                  triggerPercentage: 1.01,
                  limitPercentage: 1.021
                },
                athRestriction: {
                  enabled: true,
                  restrictionPercentage: 0.9,
                  candles: {
                    interval: '1d',
                    limit: 30
                  }
                }
              },
              sell: {
                currentGridTrade: {
                  triggerPercentage: 1.06,
                  limitPercentage: 0.979
                },
                stopLoss: {
                  maxLossPercentage: 0.8
                },
                conservativeMode: {
                  enabled: false,
                  factor: 0.5
                }
              }
            },
            baseAssetBalance: {
              total: 0.1,
              estimatedValue: 1555.509,
              isLessThanMinNotionalValue: false
            },
            openOrders: [
              {
                orderId: 1,
                symbol: 'BTCUSDT',
                type: 'LIMIT',
                side: 'BUY',
                price: '13000.000',
                origQty: '0.005',
                time: 1615465601162,
                currentPrice: 15555.09,
                updatedAt: expect.any(Object)
              },
              {
                orderId: 2,
                symbol: 'BTCUSDT',
                type: 'STOP_LOSS_LIMIT',
                side: 'BUY',
                price: '16000.000',
                origQty: '0.005',
                stopPrice: '16100.000',
                time: 1615465601162,
                currentPrice: 15555.09,
                differenceToCancel: -1.37423868741684,
                differenceToExecute: -3.5030976998525976,
                updatedAt: expect.any(Object)
              },
              {
                orderId: 3,
                symbol: 'BTCUSDT',
                type: 'STOP_LOSS_LIMIT',
                side: 'SELL',
                price: '16000.000',
                origQty: '0.005',
                stopPrice: '15900.000',
                time: 1615465601162,
                currentPrice: 15555.09,
                differenceToCancel: -4.40995396669539,
                differenceToExecute: -2.2173449333947826,
                minimumProfit: 35,
                minimumProfitPercentage: 77.77777777777777,
                updatedAt: expect.any(Object)
              }
            ],
            indicators: {
              highestPrice: 10000,
              lowestPrice: 8893.03,
              athPrice: 9000
            },
            lastCandle: {
              symbol: 'BTCUSDT',
              close: '15555.09000000'
            },
            buy: {
              currentPrice: 15555.09,
              limitPrice: 15881.746889999999,
              highestPrice: 10000,
              lowestPrice: 8893.03,
              athPrice: 9000,
              athRestrictionPrice: 8100,
              triggerPrice: 9090,
              difference: 71.12310231023102,
              openOrders: [
                {
                  orderId: 1,
                  symbol: 'BTCUSDT',
                  type: 'LIMIT',
                  side: 'BUY',
                  price: '13000.000',
                  origQty: '0.005',
                  time: 1615465601162,
                  currentPrice: 15555.09,
                  updatedAt: expect.any(Object)
                },
                {
                  orderId: 2,
                  symbol: 'BTCUSDT',
                  type: 'STOP_LOSS_LIMIT',
                  side: 'BUY',
                  price: '16000.000',
                  origQty: '0.005',
                  stopPrice: '16100.000',
                  time: 1615465601162,
                  currentPrice: 15555.09,
                  differenceToCancel: -1.37423868741684,
                  differenceToExecute: -3.5030976998525976,
                  updatedAt: expect.any(Object)
                }
              ],
              processMessage: '',
              updatedAt: expect.any(Object)
            },
            sell: {
              currentPrice: 15555.09,
              limitPrice: 15228.43311,
              lastBuyPrice: 9000,
              triggerPrice: 9540,
              difference: 38.669593039963125,
              currentProfit: 655.509,
              currentProfitPercentage: 72.83433333333333,
              stopLossDifference: 53.712900407519335,
              stopLossTriggerPrice: 7200,
              openOrders: [
                {
                  orderId: 3,
                  symbol: 'BTCUSDT',
                  type: 'STOP_LOSS_LIMIT',
                  side: 'SELL',
                  price: '16000.000',
                  origQty: '0.005',
                  stopPrice: '15900.000',
                  time: 1615465601162,
                  currentPrice: 15555.09,
                  differenceToCancel: -4.40995396669539,
                  differenceToExecute: -2.2173449333947826,
                  minimumProfit: 35,
                  minimumProfitPercentage: 77.77777777777777,
                  updatedAt: expect.any(Object)
                }
              ],
              conservativeModeApplicable: false,
              triggerPercentage: 1.06,
              processMessage: '',
              updatedAt: expect.any(Object)
            },
            tradingView: {
              request: {
                symbol: 'BTCUSDT',
                screener: 'CRYPTO',
                exchange: 'BINANCE',
                interval: '15m'
              },
              result: {
                summary: {
                  RECOMMENDATION: 'SELL',
                  BUY: 4,
                  SELL: 14,
                  NEUTRAL: 8
                }
              }
            }
          });
        });
      });

      describe('when buy grid trade index is 1 with conservative mode enabled', () => {
        beforeEach(async () => {
          step = require('../get-indicators');

          rawData = {
            symbol: 'BTCUSDT',
            symbolInfo: {
              filterMinNotional: { minNotional: '10.000' }
            },
            symbolConfiguration: {
              candles: { limit: '100' },
              buy: {
                currentGridTradeIndex: 1,
                currentGridTrade: {
                  triggerPercentage: 1.01,
                  limitPercentage: 1.021
                },
                athRestriction: {
                  enabled: true,
                  restrictionPercentage: 0.9,
                  candles: {
                    interval: '1d',
                    limit: 30
                  }
                },
                gridTrade: [
                  {
                    executed: true
                  },
                  {
                    executed: true
                  }
                ]
              },
              sell: {
                currentGridTrade: {
                  triggerPercentage: 1.06,
                  limitPercentage: 0.979
                },
                stopLoss: { maxLossPercentage: 0.8 },
                conservativeMode: {
                  enabled: true,
                  factor: 0.5
                }
              }
            },
            baseAssetBalance: { total: 0.1 },
            openOrders: [
              {
                orderId: 1,
                symbol: 'BTCUSDT',
                type: 'LIMIT',
                side: 'BUY',
                price: '13000.000',
                origQty: '0.005',
                time: 1615465601162
              },
              {
                orderId: 2,
                symbol: 'BTCUSDT',
                type: 'STOP_LOSS_LIMIT',
                side: 'BUY',
                price: '16000.000',
                origQty: '0.005',
                stopPrice: '16100.000',
                time: 1615465601162
              },
              {
                orderId: 3,
                symbol: 'BTCUSDT',
                type: 'STOP_LOSS_LIMIT',
                side: 'SELL',
                price: '16000.000',
                origQty: '0.005',
                stopPrice: '15900.000',
                time: 1615465601162
              }
            ]
          };

          result = await step.execute(loggerMock, rawData);
        });

        it('triggers getLastBuyPrice', () => {
          expect(mockGetLastBuyPrice).toHaveBeenCalledWith(
            loggerMock,
            'BTCUSDT'
          );
        });

        it('triggers expected value', () => {
          expect(result).toStrictEqual({
            symbol: 'BTCUSDT',
            symbolInfo: {
              filterMinNotional: { minNotional: '10.000' }
            },
            symbolConfiguration: {
              candles: { limit: '100' },
              buy: {
                currentGridTradeIndex: 1,
                currentGridTrade: {
                  triggerPercentage: 1.01,
                  limitPercentage: 1.021
                },
                athRestriction: {
                  enabled: true,
                  restrictionPercentage: 0.9,
                  candles: {
                    interval: '1d',
                    limit: 30
                  }
                },
                gridTrade: [
                  {
                    executed: true
                  },
                  {
                    executed: true
                  }
                ]
              },
              sell: {
                currentGridTrade: {
                  triggerPercentage: 1.06,
                  limitPercentage: 0.979
                },
                stopLoss: {
                  maxLossPercentage: 0.8
                },
                conservativeMode: {
                  enabled: true,
                  factor: 0.5
                }
              }
            },
            baseAssetBalance: {
              total: 0.1,
              estimatedValue: 1555.509,
              isLessThanMinNotionalValue: false
            },
            openOrders: [
              {
                orderId: 1,
                symbol: 'BTCUSDT',
                type: 'LIMIT',
                side: 'BUY',
                price: '13000.000',
                origQty: '0.005',
                time: 1615465601162,
                currentPrice: 15555.09,
                updatedAt: expect.any(Object)
              },
              {
                orderId: 2,
                symbol: 'BTCUSDT',
                type: 'STOP_LOSS_LIMIT',
                side: 'BUY',
                price: '16000.000',
                origQty: '0.005',
                stopPrice: '16100.000',
                time: 1615465601162,
                currentPrice: 15555.09,
                differenceToCancel: -1.37423868741684,
                differenceToExecute: -3.5030976998525976,
                updatedAt: expect.any(Object)
              },
              {
                orderId: 3,
                symbol: 'BTCUSDT',
                type: 'STOP_LOSS_LIMIT',
                side: 'SELL',
                price: '16000.000',
                origQty: '0.005',
                stopPrice: '15900.000',
                time: 1615465601162,
                currentPrice: 15555.09,
                differenceToCancel: -4.40995396669539,
                differenceToExecute: -2.2173449333947826,
                minimumProfit: 35,
                minimumProfitPercentage: 77.77777777777777,
                updatedAt: expect.any(Object)
              }
            ],
            indicators: {
              highestPrice: 10000,
              lowestPrice: 8893.03,
              athPrice: 9000
            },
            lastCandle: {
              symbol: 'BTCUSDT',
              close: '15555.09000000'
            },
            buy: {
              currentPrice: 15555.09,
              limitPrice: 15881.746889999999,
              highestPrice: 10000,
              lowestPrice: 8893.03,
              athPrice: 9000,
              athRestrictionPrice: 8100,
              triggerPrice: 9090,
              difference: 71.12310231023102,
              openOrders: [
                {
                  orderId: 1,
                  symbol: 'BTCUSDT',
                  type: 'LIMIT',
                  side: 'BUY',
                  price: '13000.000',
                  origQty: '0.005',
                  time: 1615465601162,
                  currentPrice: 15555.09,
                  updatedAt: expect.any(Object)
                },
                {
                  orderId: 2,
                  symbol: 'BTCUSDT',
                  type: 'STOP_LOSS_LIMIT',
                  side: 'BUY',
                  price: '16000.000',
                  origQty: '0.005',
                  stopPrice: '16100.000',
                  time: 1615465601162,
                  currentPrice: 15555.09,
                  differenceToCancel: -1.37423868741684,
                  differenceToExecute: -3.5030976998525976,
                  updatedAt: expect.any(Object)
                }
              ],
              processMessage: '',
              updatedAt: expect.any(Object)
            },
            sell: {
              currentPrice: 15555.09,
              limitPrice: 15228.43311,
              lastBuyPrice: 9000,
              triggerPrice: 9270,
              difference: 40.40535927468115,
              currentProfit: 655.509,
              currentProfitPercentage: 72.83433333333333,
              stopLossDifference: 53.712900407519335,
              stopLossTriggerPrice: 7200,
              openOrders: [
                {
                  orderId: 3,
                  symbol: 'BTCUSDT',
                  type: 'STOP_LOSS_LIMIT',
                  side: 'SELL',
                  price: '16000.000',
                  origQty: '0.005',
                  stopPrice: '15900.000',
                  time: 1615465601162,
                  currentPrice: 15555.09,
                  differenceToCancel: -4.40995396669539,
                  differenceToExecute: -2.2173449333947826,
                  minimumProfit: 35,
                  minimumProfitPercentage: 77.77777777777777,
                  updatedAt: expect.any(Object)
                }
              ],
              conservativeModeApplicable: true,
              triggerPercentage: 1.03,
              processMessage: '',
              updatedAt: expect.any(Object)
            },
            tradingView: {
              request: {
                symbol: 'BTCUSDT',
                screener: 'CRYPTO',
                exchange: 'BINANCE',
                interval: '15m'
              },
              result: {
                summary: {
                  RECOMMENDATION: 'SELL',
                  BUY: 4,
                  SELL: 14,
                  NEUTRAL: 8
                }
              }
            }
          });
        });
      });
    });

    describe('with open orders but no last buy price', () => {
      beforeEach(async () => {
        mockGetLastBuyPrice = jest.fn().mockResolvedValue(null);
        jest.mock('../../../trailingTradeHelper/common', () => ({
          getLastBuyPrice: mockGetLastBuyPrice
        }));

        cacheMock.hget = jest.fn().mockImplementation((hash, key) => {
          if (
            hash === 'trailing-trade-symbols' &&
            key === 'BTCUSDT-latest-candle'
          ) {
            return JSON.stringify({
              symbol: 'BTCUSDT',
              close: '15555.09000000'
            });
          }

          if (hash === 'trailing-trade-tradingview' && key === 'BTCUSDT') {
            return JSON.stringify({
              request: {
                symbol: 'BTCUSDT',
                screener: 'CRYPTO',
                exchange: 'BINANCE',
                interval: '15m'
              },
              result: {
                summary: {
                  RECOMMENDATION: 'SELL',
                  BUY: 4,
                  SELL: 14,
                  NEUTRAL: 8
                }
              }
            });
          }

          return null;
        });

        mongoMock.findAll = jest
          .fn()
          .mockImplementation((_logger, collectionName, _query, _params) => {
            if (collectionName === 'trailing-trade-candles') {
              return [
                {
                  interval: '1h',
                  key: 'BTCUSDT',
                  open: 8990.5,
                  high: 10000,
                  low: 8893.03,
                  close: 9899.05
                },
                {
                  interval: '1h',
                  key: 'BTCUSDT',
                  open: 8666.4,
                  high: 9000.6,
                  low: 8899.03,
                  close: 9000.1
                }
              ];
            }
            return [
              {
                interval: '1d',
                key: 'BTCUSDT',
                open: 8690.5,
                high: 9000,
                low: 8110.04,
                close: 9899.05
              },
              {
                interval: '1d',
                key: 'BTCUSDT',
                open: 7755.66,
                high: 8000,
                low: 7695.6,
                close: 8500
              }
            ];
          });

        step = require('../get-indicators');
        rawData = {
          symbol: 'BTCUSDT',
          symbolInfo: {
            filterMinNotional: { minNotional: '10.000' }
          },
          symbolConfiguration: {
            candles: { limit: '100' },
            buy: {
              currentGridTradeIndex: 0,
              currentGridTrade: {
                triggerPercentage: 1.01,
                limitPercentage: 1.021
              },
              athRestriction: {
                enabled: true,
                restrictionPercentage: 0.9,
                candles: {
                  interval: '1d',
                  limit: 30
                }
              }
            },
            sell: {
              currentGridTrade: {
                triggerPercentage: 1.06,
                limitPercentage: 0.979
              },
              stopLoss: { maxLossPercentage: 0.8 },
              conservativeMode: {
                enabled: false,
                factor: 0.5
              }
            }
          },
          baseAssetBalance: {
            total: 0.1
          },
          openOrders: [
            {
              orderId: 1,
              symbol: 'BTCUSDT',
              type: 'LIMIT',
              side: 'BUY',
              price: '13000.000',
              origQty: '0.005',
              time: 1615465601162
            },
            {
              orderId: 2,
              symbol: 'BTCUSDT',
              type: 'STOP_LOSS_LIMIT',
              side: 'BUY',
              price: '16000.000',
              origQty: '0.005',
              stopPrice: '16100.000',
              time: 1615465601162
            },
            {
              orderId: 3,
              symbol: 'BTCUSDT',
              type: 'STOP_LOSS_LIMIT',
              side: 'SELL',
              price: '16000.000',
              origQty: '0.005',
              stopPrice: '15900.000',
              time: 1615465601162
            }
          ]
        };

        result = await step.execute(loggerMock, rawData);
      });

      it('triggers expected value', () => {
        expect(result).toStrictEqual({
          symbol: 'BTCUSDT',
          symbolInfo: {
            filterMinNotional: { minNotional: '10.000' }
          },
          symbolConfiguration: {
            candles: { limit: '100' },
            buy: {
              currentGridTradeIndex: 0,
              currentGridTrade: {
                triggerPercentage: 1.01,
                limitPercentage: 1.021
              },
              athRestriction: {
                enabled: true,
                restrictionPercentage: 0.9,
                candles: {
                  interval: '1d',
                  limit: 30
                }
              }
            },
            sell: {
              currentGridTrade: {
                triggerPercentage: 1.06,
                limitPercentage: 0.979
              },
              stopLoss: {
                maxLossPercentage: 0.8
              },
              conservativeMode: {
                enabled: false,
                factor: 0.5
              }
            }
          },
          baseAssetBalance: {
            total: 0.1,
            estimatedValue: 1555.509,
            isLessThanMinNotionalValue: false
          },
          openOrders: [
            {
              orderId: 1,
              symbol: 'BTCUSDT',
              type: 'LIMIT',
              side: 'BUY',
              price: '13000.000',
              origQty: '0.005',
              time: 1615465601162,
              currentPrice: 15555.09,
              updatedAt: expect.any(Object)
            },
            {
              orderId: 2,
              symbol: 'BTCUSDT',
              type: 'STOP_LOSS_LIMIT',
              side: 'BUY',
              price: '16000.000',
              origQty: '0.005',
              stopPrice: '16100.000',
              time: 1615465601162,
              currentPrice: 15555.09,
              differenceToExecute: -3.5030976998525976,
              differenceToCancel: -1.37423868741684,
              updatedAt: expect.any(Object)
            },
            {
              orderId: 3,
              symbol: 'BTCUSDT',
              type: 'STOP_LOSS_LIMIT',
              side: 'SELL',
              price: '16000.000',
              origQty: '0.005',
              stopPrice: '15900.000',
              time: 1615465601162,
              currentPrice: 15555.09,
              differenceToExecute: -2.2173449333947826,
              differenceToCancel: null,
              minimumProfit: null,
              minimumProfitPercentage: null,
              updatedAt: expect.any(Object)
            }
          ],
          indicators: {
            highestPrice: 10000,
            lowestPrice: 8893.03,
            athPrice: 9000
          },
          lastCandle: {
            symbol: 'BTCUSDT',
            close: '15555.09000000'
          },
          buy: {
            currentPrice: 15555.09,
            limitPrice: 15881.746889999999,
            highestPrice: 10000,
            lowestPrice: 8893.03,
            triggerPrice: 8981.9603,
            athPrice: 9000,
            athRestrictionPrice: 8100,
            difference: 73.18146017634923,
            openOrders: [
              {
                orderId: 1,
                symbol: 'BTCUSDT',
                type: 'LIMIT',
                side: 'BUY',
                price: '13000.000',
                origQty: '0.005',
                time: 1615465601162,
                currentPrice: 15555.09,
                updatedAt: expect.any(Object)
              },
              {
                orderId: 2,
                symbol: 'BTCUSDT',
                type: 'STOP_LOSS_LIMIT',
                side: 'BUY',
                price: '16000.000',
                origQty: '0.005',
                stopPrice: '16100.000',
                time: 1615465601162,
                currentPrice: 15555.09,
                differenceToExecute: -3.5030976998525976,
                differenceToCancel: -1.37423868741684,
                updatedAt: expect.any(Object)
              }
            ],
            processMessage: '',
            updatedAt: expect.any(Object)
          },
          sell: {
            currentPrice: 15555.09,
            limitPrice: null,
            lastBuyPrice: null,
            triggerPrice: null,
            difference: null,
            currentProfit: null,
            currentProfitPercentage: null,
            stopLossDifference: null,
            stopLossTriggerPrice: null,
            openOrders: [
              {
                orderId: 3,
                symbol: 'BTCUSDT',
                type: 'STOP_LOSS_LIMIT',
                side: 'SELL',
                price: '16000.000',
                origQty: '0.005',
                stopPrice: '15900.000',
                time: 1615465601162,
                currentPrice: 15555.09,
                differenceToExecute: -2.2173449333947826,
                differenceToCancel: null,
                minimumProfit: null,
                minimumProfitPercentage: null,
                updatedAt: expect.any(Object)
              }
            ],
            conservativeModeApplicable: false,
            triggerPercentage: null,
            processMessage: '',
            updatedAt: expect.any(Object)
          },
          tradingView: {
            request: {
              symbol: 'BTCUSDT',
              screener: 'CRYPTO',
              exchange: 'BINANCE',
              interval: '15m'
            },
            result: {
              summary: {
                RECOMMENDATION: 'SELL',
                BUY: 4,
                SELL: 14,
                NEUTRAL: 8
              }
            }
          }
        });
      });
    });

    describe('with balance is not found', () => {
      beforeEach(async () => {
        mockGetLastBuyPrice = jest.fn().mockResolvedValue(null);
        jest.mock('../../../trailingTradeHelper/common', () => ({
          getLastBuyPrice: mockGetLastBuyPrice
        }));

        cacheMock.hget = jest.fn().mockImplementation((hash, key) => {
          if (
            hash === 'trailing-trade-symbols' &&
            key === 'BTCUSDT-latest-candle'
          ) {
            return JSON.stringify({
              symbol: 'BTCUSDT',
              close: '15555.09000000'
            });
          }

          if (hash === 'trailing-trade-tradingview' && key === 'BTCUSDT') {
            return JSON.stringify({
              request: {
                symbol: 'BTCUSDT',
                screener: 'CRYPTO',
                exchange: 'BINANCE',
                interval: '15m'
              },
              result: {
                summary: {
                  RECOMMENDATION: 'SELL',
                  BUY: 4,
                  SELL: 14,
                  NEUTRAL: 8
                }
              }
            });
          }

          return null;
        });

        mongoMock.findAll = jest
          .fn()
          .mockImplementation((_logger, collectionName, _query, _params) => {
            if (collectionName === 'trailing-trade-candles') {
              return [
                {
                  interval: '1h',
                  key: 'BTCUSDT',
                  open: 8990.5,
                  high: 10000,
                  low: 8893.03,
                  close: 9899.05
                },
                {
                  interval: '1h',
                  key: 'BTCUSDT',
                  open: 8666.4,
                  high: 9000.6,
                  low: 8899.03,
                  close: 9000.1
                }
              ];
            }
            return [
              {
                interval: '1d',
                key: 'BTCUSDT',
                open: 8690.5,
                high: 9000,
                low: 8110.04,
                close: 9899.05
              },
              {
                interval: '1d',
                key: 'BTCUSDT',
                open: 7755.66,
                high: 8000,
                low: 7695.6,
                close: 8500
              }
            ];
          });

        step = require('../get-indicators');

        rawData = {
          symbol: 'BTCUSDT',
          symbolInfo: {
            filterMinNotional: { minNotional: '10.000' }
          },
          symbolConfiguration: {
            candles: { limit: '100' },
            buy: {
              currentGridTradeIndex: 0,
              currentGridTrade: {
                triggerPercentage: 1.01,
                limitPercentage: 1.011
              },
              athRestriction: {
                enabled: true,
                restrictionPercentage: 0.9,
                candles: {
                  interval: '1d',
                  limit: 30
                }
              }
            },
            sell: {
              currentGridTrade: {
                triggerPercentage: 0.99,
                limitPercentage: 0.98
              },
              stopLoss: { maxLossPercentage: 0.8 },
              conservativeMode: {
                enabled: false,
                factor: 0.5
              }
            }
          },
          baseAssetBalance: {
            total: 0.1
          },
          openOrders: [],
          buy: {
            processMessage: 'Hello'
          },
          sell: {
            processMessage: 'World'
          }
        };

        result = await step.execute(loggerMock, rawData);
      });

      it('triggers expected value', () => {
        expect(result).toStrictEqual({
          symbol: 'BTCUSDT',
          symbolInfo: {
            filterMinNotional: { minNotional: '10.000' }
          },
          symbolConfiguration: {
            candles: { limit: '100' },
            buy: {
              currentGridTradeIndex: 0,
              currentGridTrade: {
                triggerPercentage: 1.01,
                limitPercentage: 1.011
              },
              athRestriction: {
                enabled: true,
                restrictionPercentage: 0.9,
                candles: {
                  interval: '1d',
                  limit: 30
                }
              }
            },
            sell: {
              currentGridTrade: {
                triggerPercentage: 0.99,
                limitPercentage: 0.98
              },
              stopLoss: {
                maxLossPercentage: 0.8
              },
              conservativeMode: {
                enabled: false,
                factor: 0.5
              }
            }
          },
          baseAssetBalance: {
            total: 0.1,
            estimatedValue: 1555.509,
            isLessThanMinNotionalValue: false
          },
          openOrders: [],
          indicators: {
            highestPrice: 10000,
            lowestPrice: 8893.03,
            athPrice: 9000
          },
          lastCandle: {
            symbol: 'BTCUSDT',
            close: '15555.09000000'
          },
          buy: {
            currentPrice: 15555.09,
            limitPrice: 15726.195989999998,
            highestPrice: 10000,
            lowestPrice: 8893.03,
            athPrice: 9000,
            athRestrictionPrice: 8100,
            triggerPrice: 8981.9603,
            difference: 73.18146017634923,
            openOrders: [],
            processMessage: 'Hello',
            updatedAt: expect.any(Object)
          },
          sell: {
            currentPrice: 15555.09,
            limitPrice: null,
            lastBuyPrice: null,
            triggerPrice: null,
            difference: null,
            currentProfit: null,
            currentProfitPercentage: null,
            stopLossDifference: null,
            stopLossTriggerPrice: null,
            openOrders: [],
            conservativeModeApplicable: false,
            triggerPercentage: null,
            processMessage: 'World',
            updatedAt: expect.any(Object)
          },
          tradingView: {
            request: {
              symbol: 'BTCUSDT',
              screener: 'CRYPTO',
              exchange: 'BINANCE',
              interval: '15m'
            },
            result: {
              summary: {
                RECOMMENDATION: 'SELL',
                BUY: 4,
                SELL: 14,
                NEUTRAL: 8
              }
            }
          }
        });
      });
    });

    describe('when there are no candles from mongo', () => {
      beforeEach(async () => {
        mockGetLastBuyPrice = jest.fn().mockResolvedValue(null);
        jest.mock('../../../trailingTradeHelper/common', () => ({
          getLastBuyPrice: mockGetLastBuyPrice
        }));

        cacheMock.hget = jest.fn().mockImplementation((hash, key) => {
          if (
            hash === 'trailing-trade-symbols' &&
            key === 'BTCUSDT-latest-candle'
          ) {
            return JSON.stringify({
              symbol: 'BTCUSDT',
              close: '15555.09000000'
            });
          }

          return null;
        });

        mongoMock.findAll = jest.fn().mockResolvedValue([]);

        step = require('../get-indicators');

        rawData = {
          symbol: 'BTCUSDT',
          symbolInfo: {
            filterMinNotional: { minNotional: '10.000' }
          },
          symbolConfiguration: {
            candles: { limit: '100' },
            buy: {
              currentGridTradeIndex: 0,
              currentGridTrade: {
                triggerPercentage: 1.01,
                limitPercentage: 1.021
              },
              athRestriction: {
                enabled: true,
                restrictionPercentage: 0.9,
                candles: {
                  interval: '1d',
                  limit: 30
                }
              }
            },
            sell: {
              currentGridTrade: {
                triggerPercentage: 1.06,
                limitPercentage: 0.979
              },
              stopLoss: { maxLossPercentage: 0.8 },
              conservativeMode: {
                enabled: false,
                factor: 0.5
              }
            }
          },
          baseAssetBalance: { total: 0.1 },
          openOrders: []
        };

        result = await step.execute(loggerMock, rawData);
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual({
          symbol: 'BTCUSDT',
          symbolInfo: {
            filterMinNotional: { minNotional: '10.000' }
          },
          symbolConfiguration: {
            candles: { limit: '100' },
            buy: {
              currentGridTradeIndex: 0,
              currentGridTrade: {
                triggerPercentage: 1.01,
                limitPercentage: 1.021
              },
              athRestriction: {
                enabled: true,
                restrictionPercentage: 0.9,
                candles: {
                  interval: '1d',
                  limit: 30
                }
              }
            },
            sell: {
              currentGridTrade: {
                triggerPercentage: 1.06,
                limitPercentage: 0.979
              },
              stopLoss: { maxLossPercentage: 0.8 },
              conservativeMode: {
                enabled: false,
                factor: 0.5
              }
            }
          },
          baseAssetBalance: { total: 0.1 },
          openOrders: [],
          saveToCache: false
        });
      });
    });

    describe('when there is no latest candle cache', () => {
      beforeEach(async () => {
        mockGetLastBuyPrice = jest.fn().mockResolvedValue(null);
        jest.mock('../../../trailingTradeHelper/common', () => ({
          getLastBuyPrice: mockGetLastBuyPrice
        }));

        cacheMock.hget = jest.fn().mockResolvedValue(null);

        mongoMock.findAll = jest
          .fn()
          .mockImplementation((_logger, collectionName, _query, _params) => {
            if (collectionName === 'trailing-trade-candles') {
              return [
                {
                  interval: '1h',
                  key: 'BTCUSDT',
                  open: 8990.5,
                  high: 10000,
                  low: 8893.03,
                  close: 9899.05,
                  time: 1660830000000
                },
                {
                  interval: '1h',
                  key: 'BTCUSDT',
                  open: 8666.4,
                  high: 9000.6,
                  low: 8899.03,
                  close: 9000.1,
                  time: 1660830000000
                }
              ];
            }
            return [
              {
                interval: '1d',
                key: 'BTCUSDT',
                open: 8690.5,
                high: 9000,
                low: 8110.04,
                close: 9899.05,
                time: 1660830000000
              },
              {
                interval: '1d',
                key: 'BTCUSDT',
                open: 7755.66,
                high: 8000,
                low: 7695.6,
                close: 8500,
                time: 1660830000000
              }
            ];
          });

        step = require('../get-indicators');

        rawData = {
          symbol: 'BTCUSDT',
          symbolInfo: {
            filterMinNotional: { minNotional: '10.000' }
          },
          symbolConfiguration: {
            candles: { limit: '100' },
            buy: {
              currentGridTradeIndex: 0,
              currentGridTrade: {
                triggerPercentage: 1.01,
                limitPercentage: 1.021
              },
              athRestriction: {
                enabled: true,
                restrictionPercentage: 0.9,
                candles: {
                  interval: '1d',
                  limit: 30
                }
              }
            },
            sell: {
              currentGridTrade: {
                triggerPercentage: 1.06,
                limitPercentage: 0.979
              },
              stopLoss: { maxLossPercentage: 0.8 },
              conservativeMode: {
                enabled: false,
                factor: 0.5
              }
            }
          },
          baseAssetBalance: { total: 0.1 },
          openOrders: []
        };

        result = await step.execute(loggerMock, rawData);
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual({
          symbol: 'BTCUSDT',
          symbolInfo: {
            filterMinNotional: { minNotional: '10.000' }
          },
          symbolConfiguration: {
            candles: { limit: '100' },
            buy: {
              currentGridTradeIndex: 0,
              currentGridTrade: {
                triggerPercentage: 1.01,
                limitPercentage: 1.021
              },
              athRestriction: {
                enabled: true,
                restrictionPercentage: 0.9,
                candles: {
                  interval: '1d',
                  limit: 30
                }
              }
            },
            sell: {
              currentGridTrade: {
                limitPercentage: 0.979,
                triggerPercentage: 1.06
              },
              stopLoss: {
                maxLossPercentage: 0.8
              },
              conservativeMode: {
                enabled: false,
                factor: 0.5
              }
            }
          },
          baseAssetBalance: {
            total: 0.1,
            estimatedValue: 989.905,
            isLessThanMinNotionalValue: false
          },
          openOrders: [],
          indicators: {
            highestPrice: 10000,
            lowestPrice: 8893.03,
            athPrice: 9000
          },
          lastCandle: {
            eventType: '24hrMiniTicker',
            eventTime: 1660830000000,
            symbol: 'BTCUSDT',
            close: 9899.05
          },
          buy: {
            currentPrice: 9899.05,
            limitPrice: 10106.930049999999,
            highestPrice: 10000,
            lowestPrice: 8893.03,
            athPrice: 9000,
            athRestrictionPrice: 8100,
            triggerPrice: 8981.9603,
            difference: 10.210351297143871,
            openOrders: [],
            processMessage: '',
            updatedAt: expect.any(Object)
          },
          sell: {
            currentPrice: 9899.05,
            limitPrice: null,
            lastBuyPrice: null,
            triggerPrice: null,
            difference: null,
            currentProfit: null,
            currentProfitPercentage: null,
            stopLossDifference: null,
            stopLossTriggerPrice: null,
            openOrders: [],
            conservativeModeApplicable: false,
            triggerPercentage: null,
            processMessage: '',
            updatedAt: expect.any(Object)
          },
          tradingView: {}
        });
      });
    });

    describe('when there is no tradingview indicator', () => {
      beforeEach(async () => {
        mockGetLastBuyPrice = jest.fn().mockResolvedValue(null);
        jest.mock('../../../trailingTradeHelper/common', () => ({
          getLastBuyPrice: mockGetLastBuyPrice
        }));

        cacheMock.hget = jest.fn().mockImplementation((hash, key) => {
          if (
            hash === 'trailing-trade-symbols' &&
            key === 'BTCUSDT-latest-candle'
          ) {
            return JSON.stringify({
              symbol: 'BTCUSDT',
              close: '15555.09000000'
            });
          }

          return null;
        });

        mongoMock.findAll = jest
          .fn()
          .mockImplementation((_logger, collectionName, _query, _params) => {
            if (collectionName === 'trailing-trade-candles') {
              return [
                {
                  interval: '1h',
                  key: 'BTCUSDT',
                  open: 8990.5,
                  high: 10000,
                  low: 8893.03,
                  close: 9899.05
                },
                {
                  interval: '1h',
                  key: 'BTCUSDT',
                  open: 8666.4,
                  high: 9000.6,
                  low: 8899.03,
                  close: 9000.1
                }
              ];
            }
            return [
              {
                interval: '1d',
                key: 'BTCUSDT',
                open: 8690.5,
                high: 9000,
                low: 8110.04,
                close: 9899.05
              },
              {
                interval: '1d',
                key: 'BTCUSDT',
                open: 7755.66,
                high: 8000,
                low: 7695.6,
                close: 8500
              }
            ];
          });

        step = require('../get-indicators');
        rawData = {
          symbol: 'BTCUSDT',
          symbolInfo: {
            filterMinNotional: { minNotional: '10.000' }
          },
          symbolConfiguration: {
            candles: { limit: '100' },
            buy: {
              currentGridTradeIndex: 0,
              currentGridTrade: {
                triggerPercentage: 1.01,
                limitPercentage: 1.021
              },
              athRestriction: {
                enabled: true,
                restrictionPercentage: 0.9,
                candles: {
                  interval: '1d',
                  limit: 30
                }
              }
            },
            sell: {
              currentGridTrade: {
                triggerPercentage: 1.06,
                limitPercentage: 0.979
              },
              stopLoss: { maxLossPercentage: 0.8 },
              conservativeMode: {
                enabled: false,
                factor: 0.5
              }
            }
          },
          baseAssetBalance: {
            total: 0.1
          },
          openOrders: []
        };

        result = await step.execute(loggerMock, rawData);
      });

      it('triggers expected value', () => {
        expect(result).toStrictEqual({
          symbol: 'BTCUSDT',
          symbolInfo: {
            filterMinNotional: { minNotional: '10.000' }
          },
          symbolConfiguration: {
            candles: { limit: '100' },
            buy: {
              currentGridTradeIndex: 0,
              currentGridTrade: {
                triggerPercentage: 1.01,
                limitPercentage: 1.021
              },
              athRestriction: {
                enabled: true,
                restrictionPercentage: 0.9,
                candles: {
                  interval: '1d',
                  limit: 30
                }
              }
            },
            sell: {
              currentGridTrade: {
                triggerPercentage: 1.06,
                limitPercentage: 0.979
              },
              stopLoss: {
                maxLossPercentage: 0.8
              },
              conservativeMode: {
                enabled: false,
                factor: 0.5
              }
            }
          },
          baseAssetBalance: {
            total: 0.1,
            estimatedValue: 1555.509,
            isLessThanMinNotionalValue: false
          },
          openOrders: [],
          indicators: {
            highestPrice: 10000,
            lowestPrice: 8893.03,
            athPrice: 9000
          },
          lastCandle: {
            symbol: 'BTCUSDT',
            close: '15555.09000000'
          },
          buy: {
            currentPrice: 15555.09,
            limitPrice: 15881.746889999999,
            highestPrice: 10000,
            lowestPrice: 8893.03,
            triggerPrice: 8981.9603,
            athPrice: 9000,
            athRestrictionPrice: 8100,
            difference: 73.18146017634923,
            openOrders: [],
            processMessage: '',
            updatedAt: expect.any(Object)
          },
          sell: {
            currentPrice: 15555.09,
            limitPrice: null,
            lastBuyPrice: null,
            triggerPrice: null,
            difference: null,
            currentProfit: null,
            currentProfitPercentage: null,
            stopLossDifference: null,
            stopLossTriggerPrice: null,
            openOrders: [],
            conservativeModeApplicable: false,
            triggerPercentage: null,
            processMessage: '',
            updatedAt: expect.any(Object)
          },
          tradingView: {}
        });
      });
    });
  });
});
