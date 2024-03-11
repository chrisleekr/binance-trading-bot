/* eslint-disable global-require */

describe('get-indicators.js', () => {
  let result;
  let rawData;
  let step;

  let cacheMock;
  let loggerMock;
  let mongoMock;

  let mockGetLastBuyPrice;

  const clearMocks = () => {
    jest.clearAllMocks().resetModules();

    const { cache, logger, mongo } = require('../../../../helpers');
    cacheMock = cache;
    loggerMock = logger;
    mongoMock = mongo;
  };

  const mockLatestCandle = close => {
    cacheMock.hget = jest.fn().mockImplementation((hash, key) => {
      if (
        hash === 'trailing-trade-symbols' &&
        key === 'BTCUSDT-latest-candle'
      ) {
        return JSON.stringify({
          symbol: 'BTCUSDT',
          close: `${close}`
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

    // Set high price to be 10% higher than the close price
    const high = close + close * 0.1;

    const athHigh = high + high * 0.01;

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
              high,
              low: 8899.03,
              close
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
            high: athHigh,
            low: 7695.6,
            close
          }
        ];
      });
  };

  const mockLastBuyPrice = lastBuyPrice => {
    mockGetLastBuyPrice = jest.fn().mockResolvedValue(lastBuyPrice);
    jest.mock('../../../trailingTradeHelper/common', () => ({
      getLastBuyPrice: mockGetLastBuyPrice
    }));
  };

  const baseRawData = {
    symbol: 'BTCUSDT',
    symbolInfo: {
      filterMinNotional: { minNotional: '10.000' }
    }
  };
  describe('execute', () => {
    beforeEach(() => {
      clearMocks();
    });

    describe('with no open orders and no last buy price', () => {
      beforeEach(async () => {
        mockLatestCandle(9000);
        mockLastBuyPrice(null);

        step = require('../get-indicators');

        rawData = {
          ...baseRawData,
          symbolConfiguration: {
            candles: { limit: '100' },
            buy: {
              currentGridTradeIndex: 0,
              currentGridTrade: {
                triggerPercentage: 1,
                limitPercentage: 1.036
              },
              gridTrade: [
                {
                  triggerPercentage: 1,
                  limitPercentage: 1.036,
                  executed: false
                },
                {
                  triggerPercentage: 0.9,
                  limitPercentage: 1.046,
                  executed: false
                }
              ],
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
              currentGridTradeIndex: 0,
              currentGridTrade: {
                triggerPercentage: 1.06,
                limitPercentage: 0.979
              },
              gridTrade: [
                {
                  triggerPercentage: 1.06,
                  limitPercentage: 0.979,
                  executed: false
                }
              ],
              stopLoss: { maxLossPercentage: 0.8 },
              conservativeMode: {
                enabled: false,
                factor: 0.5
              }
            }
          },
          baseAssetBalance: { total: 0 },
          openOrders: []
        };

        result = await step.execute(loggerMock, rawData);
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual({
          ...rawData,
          baseAssetBalance: {
            total: 0,
            estimatedValue: 0,
            isLessThanMinNotionalValue: true
          },
          openOrders: [],
          indicators: {
            highestPrice: 10000,
            lowestPrice: 8893.03,
            athPrice: 9999
          },
          lastCandle: {
            symbol: 'BTCUSDT',
            close: '9000'
          },
          buy: {
            currentPrice: 9000,
            limitPrice: 9324,
            highestPrice: 10000,
            lowestPrice: 8893.03,
            athPrice: 9999,
            athRestrictionPrice: 8999.1,
            triggerPrice: 8893.03,
            difference: 1.2028521212680054,
            nextBestBuyAmount: null,
            nextBestBuyCalculation: null,
            openOrders: [],
            processMessage: '',
            updatedAt: expect.any(Object)
          },
          sell: {
            currentPrice: 9000,
            limitPrice: null,
            lastBuyPrice: null,
            triggerPrice: null,
            difference: null,
            stopLossTriggerPrice: null,
            stopLossDifference: null,
            currentProfit: null,
            currentProfitPercentage: null,
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

    describe('with disabled ATH restriction', () => {
      beforeEach(async () => {
        mockLatestCandle(15555.09);
        mockLastBuyPrice(null);

        step = require('../get-indicators');

        rawData = {
          ...baseRawData,
          symbolConfiguration: {
            candles: { limit: '100' },
            buy: {
              currentGridTradeIndex: 0,
              currentGridTrade: {
                triggerPercentage: 1.01,
                limitPercentage: 1.021
              },
              gridTrade: [
                {
                  triggerPercentage: 1.01,
                  limitPercentage: 1.021,
                  executed: false
                },
                {
                  triggerPercentage: 0.9,
                  limitPercentage: 1.046,
                  executed: false
                }
              ],
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
              currentGridTradeIndex: 0,
              currentGridTrade: {
                triggerPercentage: 1.06,
                limitPercentage: 0.979
              },
              gridTrade: [
                {
                  triggerPercentage: 1.06,
                  limitPercentage: 0.979,
                  executed: false
                }
              ],
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
          ...rawData,
          baseAssetBalance: {
            total: 0.1,
            estimatedValue: 1555.509,
            isLessThanMinNotionalValue: false
          },
          openOrders: [],
          indicators: {
            highestPrice: 17110.599000000002,
            lowestPrice: 8893.03,
            athPrice: null
          },
          lastCandle: {
            symbol: 'BTCUSDT',
            close: '15555.09'
          },
          buy: {
            currentPrice: 15555.09,
            limitPrice: 15881.746889999999,
            highestPrice: 17110.599000000002,
            lowestPrice: 8893.03,
            athPrice: null,
            athRestrictionPrice: null,
            triggerPrice: 8981.9603,
            nextBestBuyAmount: null,
            nextBestBuyCalculation: null,
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
        mockLastBuyPrice({ lastBuyPrice: 9000, quantity: 1 });
        mockLatestCandle(8900.05);

        step = require('../get-indicators');
      });

      describe('(should not happen) when buy grid trade index is null', () => {
        beforeEach(async () => {
          rawData = {
            ...baseRawData,
            symbolConfiguration: {
              candles: { limit: '100' },
              buy: {
                currentGridTradeIndex: -1,
                currentGridTrade: null,
                gridTrade: [],
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
                currentGridTradeIndex: null,
                currentGridTrade: null,
                gridTrade: [],
                stopLoss: { maxLossPercentage: 0.8 },
                conservativeMode: {
                  enabled: false,
                  factor: 0.5
                }
              }
            },
            baseAssetBalance: { total: 0 },
            openOrders: []
          };

          result = await step.execute(loggerMock, rawData);
        });

        it('triggers expected value', () => {
          expect(result).toStrictEqual({
            ...rawData,
            baseAssetBalance: {
              total: 0,
              estimatedValue: 0,
              isLessThanMinNotionalValue: true
            },
            openOrders: [],
            indicators: {
              highestPrice: 10000,
              lowestPrice: 8893.03,
              athPrice: 9887.955549999999
            },
            lastCandle: {
              symbol: 'BTCUSDT',
              close: '8900.05'
            },
            buy: {
              currentPrice: 8900.05,
              limitPrice: null,
              highestPrice: 10000,
              lowestPrice: 8893.03,
              nextBestBuyAmount: null,
              nextBestBuyCalculation: {
                buyTrigger: 0.9888944444444444,
                currentPrice: 8900.05,
                hasObviousManualTrade: false,
                isSingleSellGrid: false,
                lastBuyPrice: 9000,
                sellTrigger: null,
                totalBoughtAmount: 0,
                totalBoughtQty: 0
              },
              athPrice: 9887.955549999999,
              athRestrictionPrice: 8899.159995,
              triggerPrice: null,
              difference: null,
              openOrders: [],
              processMessage: '',
              updatedAt: expect.any(Object)
            },
            sell: {
              currentPrice: 8900.05,
              limitPrice: null,
              lastBuyPrice: 9000,
              triggerPrice: null,
              difference: null,
              currentProfit: -0,
              currentProfitPercentage: -1.110555555555559,
              stopLossDifference: 19.10157808102201,
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

      describe('(should not happen) when buy grid trade index is 0', () => {
        beforeEach(async () => {
          rawData = {
            ...baseRawData,
            symbolConfiguration: {
              candles: { limit: '100' },
              buy: {
                currentGridTradeIndex: 0,
                currentGridTrade: {
                  triggerPercentage: 1.01,
                  limitPercentage: 1.021
                },
                gridTrade: [
                  {
                    triggerPercentage: 1.01,
                    limitPercentage: 1.021,
                    executed: false
                  },
                  {
                    triggerPercentage: 0.9,
                    limitPercentage: 1.046,
                    executed: false
                  }
                ],
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
                currentGridTradeIndex: 0,
                currentGridTrade: {
                  triggerPercentage: 1.06,
                  limitPercentage: 0.979
                },
                gridTrade: [
                  {
                    triggerPercentage: 1.06,
                    limitPercentage: 0.979,
                    executed: false
                  }
                ],
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

        it('triggers expected value', () => {
          expect(result).toStrictEqual({
            ...rawData,
            baseAssetBalance: {
              total: 0.1,
              estimatedValue: 890.005,
              isLessThanMinNotionalValue: false
            },
            openOrders: [],
            indicators: {
              highestPrice: 10000,
              lowestPrice: 8893.03,
              athPrice: 9887.955549999999
            },
            lastCandle: {
              symbol: 'BTCUSDT',
              close: '8900.05'
            },
            buy: {
              currentPrice: 8900.05,
              limitPrice: 9086.951049999998,
              highestPrice: 10000,
              lowestPrice: 8893.03,
              nextBestBuyAmount: null,
              nextBestBuyCalculation: {
                buyTrigger: 0.9888944444444444,
                currentPrice: 8900.05,
                hasObviousManualTrade: true,
                isSingleSellGrid: true,
                lastBuyPrice: 9000,
                sellTrigger: 1.06,
                totalBoughtAmount: 0,
                totalBoughtQty: 0
              },
              athPrice: 9887.955549999999,
              athRestrictionPrice: 8899.159995,
              triggerPrice: 8981.9603,
              difference: -0.9119423518271552,
              openOrders: [],
              processMessage: '',
              updatedAt: expect.any(Object)
            },
            sell: {
              currentPrice: 8900.05,
              limitPrice: 8713.148949999999,
              lastBuyPrice: 9000,
              triggerPrice: 9540,
              difference: -7.190409042645829,
              currentProfit: -9.995000000000074,
              currentProfitPercentage: -1.110555555555559,
              stopLossDifference: 19.10157808102201,
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

      describe('when buy grid trade index is 1 after executing the 1st grid trade', () => {
        beforeEach(async () => {
          rawData = {
            ...baseRawData,
            symbolConfiguration: {
              candles: { limit: '100' },
              buy: {
                currentGridTradeIndex: 1,
                currentGridTrade: {
                  triggerPercentage: 1.01,
                  limitPercentage: 1.021
                },
                gridTrade: [
                  {
                    triggerPercentage: 1.01,
                    limitPercentage: 1.021,
                    executed: true,
                    executedOrder: { cummulativeQuoteQty: 9000, executedQty: 1 }
                  },
                  {
                    triggerPercentage: 0.9,
                    limitPercentage: 1.046,
                    executed: false
                  }
                ],
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
                currentGridTradeIndex: 0,
                currentGridTrade: {
                  triggerPercentage: 1.06,
                  limitPercentage: 0.979
                },
                gridTrade: [
                  {
                    triggerPercentage: 1.06,
                    limitPercentage: 0.979,
                    executed: false
                  }
                ],
                stopLoss: { maxLossPercentage: 0.8 },
                conservativeMode: {
                  enabled: false,
                  factor: 0.5
                }
              }
            },
            baseAssetBalance: { total: 1 },
            openOrders: []
          };

          result = await step.execute(loggerMock, rawData);
        });

        it('triggers expected value', () => {
          expect(result).toStrictEqual({
            ...rawData,
            baseAssetBalance: {
              total: 1,
              estimatedValue: 8900.05,
              isLessThanMinNotionalValue: false
            },
            openOrders: [],
            indicators: {
              highestPrice: 10000,
              lowestPrice: 8893.03,
              athPrice: 9887.955549999999
            },
            lastCandle: {
              symbol: 'BTCUSDT',
              close: '8900.05'
            },
            buy: {
              currentPrice: 8900.05,
              limitPrice: 9086.951049999998,
              highestPrice: 10000,
              lowestPrice: 8893.03,
              nextBestBuyAmount: -7234.216666666658,
              nextBestBuyCalculation: {
                buyTrigger: 0.9888944444444444,
                currentPrice: 8900.05,
                hasObviousManualTrade: false,
                isSingleSellGrid: true,
                lastBuyPrice: 9000,
                sellTrigger: 1.06,
                totalBoughtAmount: 9000,
                totalBoughtQty: 1
              },
              athPrice: 9887.955549999999,
              athRestrictionPrice: 8899.159995,
              triggerPrice: 9090,
              difference: -2.0896589658966014,
              openOrders: [],
              processMessage: '',
              updatedAt: expect.any(Object)
            },
            sell: {
              currentPrice: 8900.05,
              limitPrice: 8713.148949999999,
              lastBuyPrice: 9000,
              triggerPrice: 9540,
              difference: -7.190409042645829,
              currentProfit: -99.95000000000073,
              currentProfitPercentage: -1.110555555555559,
              stopLossDifference: 19.10157808102201,
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

      describe('when buy grid trade index is 1 after setting the last buy price', () => {
        beforeEach(async () => {
          rawData = {
            ...baseRawData,
            symbolConfiguration: {
              candles: { limit: '100' },
              buy: {
                currentGridTradeIndex: 1,
                currentGridTrade: {
                  triggerPercentage: 1.01,
                  limitPercentage: 1.021
                },
                gridTrade: [
                  {
                    triggerPercentage: 1.01,
                    limitPercentage: 1.021,
                    executed: false
                  },
                  {
                    triggerPercentage: 0.9,
                    limitPercentage: 1.046,
                    executed: false
                  }
                ],
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
                currentGridTradeIndex: 0,
                currentGridTrade: {
                  triggerPercentage: 1.06,
                  limitPercentage: 0.979
                },
                gridTrade: [
                  {
                    triggerPercentage: 1.06,
                    limitPercentage: 0.979,
                    executed: false
                  }
                ],
                stopLoss: { maxLossPercentage: 0.8 },
                conservativeMode: {
                  enabled: false,
                  factor: 0.5
                }
              }
            },
            baseAssetBalance: { total: 0 },
            openOrders: []
          };

          result = await step.execute(loggerMock, rawData);
        });

        it('triggers expected value', () => {
          expect(result).toStrictEqual({
            ...rawData,
            baseAssetBalance: {
              total: 0,
              estimatedValue: 0,
              isLessThanMinNotionalValue: true
            },
            openOrders: [],
            indicators: {
              highestPrice: 10000,
              lowestPrice: 8893.03,
              athPrice: 9887.955549999999
            },
            lastCandle: {
              symbol: 'BTCUSDT',
              close: '8900.05'
            },
            buy: {
              currentPrice: 8900.05,
              limitPrice: 9086.951049999998,
              highestPrice: 10000,
              lowestPrice: 8893.03,
              nextBestBuyAmount: null,
              nextBestBuyCalculation: {
                buyTrigger: 0.9888944444444444,
                currentPrice: 8900.05,
                hasObviousManualTrade: true,
                isSingleSellGrid: true,
                lastBuyPrice: 9000,
                sellTrigger: 1.06,
                totalBoughtAmount: 0,
                totalBoughtQty: 0
              },
              athPrice: 9887.955549999999,
              athRestrictionPrice: 8899.159995,
              triggerPrice: 9090,
              difference: -2.0896589658966014,
              openOrders: [],
              processMessage: '',
              updatedAt: expect.any(Object)
            },
            sell: {
              currentPrice: 8900.05,
              limitPrice: 8713.148949999999,
              lastBuyPrice: 9000,
              triggerPrice: 9540,
              difference: -7.190409042645829,
              currentProfit: -0,
              currentProfitPercentage: -1.110555555555559,
              stopLossDifference: 19.10157808102201,
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
          rawData = {
            ...baseRawData,
            symbolConfiguration: {
              candles: { limit: '100' },
              buy: {
                currentGridTradeIndex: 1,
                currentGridTrade: {
                  triggerPercentage: 0.9,
                  limitPercentage: 1.046
                },
                gridTrade: [
                  {
                    triggerPercentage: 1.01,
                    limitPercentage: 1.021,
                    executed: true,
                    executedOrder: {
                      cummulativeQuoteQty: 9000,
                      executedQty: 1
                    }
                  },
                  {
                    triggerPercentage: 0.9,
                    limitPercentage: 1.046,
                    executed: false
                  }
                ],
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
                currentGridTradeIndex: 0,
                currentGridTrade: {
                  triggerPercentage: 1.06,
                  limitPercentage: 0.979
                },
                gridTrade: [
                  {
                    triggerPercentage: 1.06,
                    limitPercentage: 0.979,
                    executed: false
                  }
                ],
                stopLoss: { maxLossPercentage: 0.8 },
                conservativeMode: {
                  enabled: true,
                  factor: 0.5
                }
              }
            },
            baseAssetBalance: { total: 1 },
            openOrders: []
          };

          result = await step.execute(loggerMock, rawData);
        });

        it('triggers expected value', () => {
          expect(result).toStrictEqual({
            ...rawData,
            baseAssetBalance: {
              total: 1,
              estimatedValue: 8900.05,
              isLessThanMinNotionalValue: false
            },
            openOrders: [],
            indicators: {
              highestPrice: 10000,
              lowestPrice: 8893.03,
              athPrice: 9887.955549999999
            },
            lastCandle: {
              symbol: 'BTCUSDT',
              close: '8900.05'
            },
            buy: {
              currentPrice: 8900.05,
              limitPrice: 9309.452299999999,
              highestPrice: 10000,
              lowestPrice: 8893.03,
              nextBestBuyAmount: -5568.383333333314,
              nextBestBuyCalculation: {
                buyTrigger: 0.9888944444444444,
                currentPrice: 8900.05,
                hasObviousManualTrade: false,
                isSingleSellGrid: true,
                lastBuyPrice: 9000,
                sellTrigger: 1.03,
                totalBoughtAmount: 9000,
                totalBoughtQty: 1
              },
              athPrice: 9887.955549999999,
              athRestrictionPrice: 8899.159995,
              triggerPrice: 8100,
              difference: 9.877160493827141,
              openOrders: [],
              processMessage: '',
              updatedAt: expect.any(Object)
            },
            sell: {
              currentPrice: 8900.05,
              limitPrice: 8713.148949999999,
              lastBuyPrice: 9000,
              triggerPrice: 9540,
              difference: -7.190409042645829,
              currentProfit: -99.95000000000073,
              currentProfitPercentage: -1.110555555555559,
              stopLossDifference: 19.10157808102201,
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

      describe('when buy grid trade index is 2 and conservative mode enabled', () => {
        beforeEach(async () => {
          rawData = {
            ...baseRawData,
            symbolConfiguration: {
              candles: { limit: '100' },
              buy: {
                currentGridTradeIndex: 2,
                currentGridTrade: {
                  triggerPercentage: 0.9,
                  limitPercentage: 1.046
                },
                gridTrade: [
                  {
                    triggerPercentage: 1.01,
                    limitPercentage: 1.021,
                    executed: true,
                    executedOrder: { cummulativeQuoteQty: 9000, executedQty: 1 }
                  },
                  {
                    triggerPercentage: 0.9,
                    limitPercentage: 1.046,
                    executed: true,
                    executedOrder: { cummulativeQuoteQty: 8900, executedQty: 1 }
                  },
                  {
                    triggerPercentage: 0.9,
                    limitPercentage: 1.046,
                    executed: false
                  }
                ],
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
                currentGridTradeIndex: 0,
                currentGridTrade: {
                  triggerPercentage: 1.06,
                  limitPercentage: 0.979
                },
                gridTrade: [
                  {
                    triggerPercentage: 1.06,
                    limitPercentage: 0.979,
                    executed: false
                  }
                ],
                stopLoss: { maxLossPercentage: 0.8 },
                conservativeMode: {
                  enabled: true,
                  factor: 0.5
                }
              }
            },
            baseAssetBalance: { total: 2 },
            openOrders: []
          };

          result = await step.execute(loggerMock, rawData);
        });

        it('triggers expected value', () => {
          expect(result).toStrictEqual({
            ...rawData,
            baseAssetBalance: {
              total: 2,
              estimatedValue: 17800.1,
              isLessThanMinNotionalValue: false
            },
            openOrders: [],
            indicators: {
              highestPrice: 10000,
              lowestPrice: 8893.03,
              athPrice: 9887.955549999999
            },
            lastCandle: {
              symbol: 'BTCUSDT',
              close: '8900.05'
            },
            buy: {
              currentPrice: 8900.05,
              limitPrice: 9309.452299999999,
              highestPrice: 10000,
              lowestPrice: 8893.03,
              nextBestBuyAmount: -11140.099999999953,
              nextBestBuyCalculation: {
                buyTrigger: 0.9888944444444444,
                currentPrice: 8900.05,
                hasObviousManualTrade: false,
                isSingleSellGrid: true,
                lastBuyPrice: 9000,
                sellTrigger: 1.0150000000000001,
                totalBoughtAmount: 17900,
                totalBoughtQty: 2
              },
              athPrice: 9887.955549999999,
              athRestrictionPrice: 8899.159995,
              triggerPrice: 8100,
              difference: 9.877160493827141,
              openOrders: [],
              processMessage: '',
              updatedAt: expect.any(Object)
            },
            sell: {
              currentPrice: 8900.05,
              limitPrice: 8713.148949999999,
              lastBuyPrice: 9000,
              triggerPrice: 9270,
              difference: -4.156718220684152,
              currentProfit: -199.90000000000146,
              currentProfitPercentage: -1.110555555555559,
              stopLossDifference: 19.10157808102201,
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
        mockLastBuyPrice({ lastBuyPrice: 9000, quantity: 1 });

        mockLatestCandle(8900);
        step = require('../get-indicators');
      });

      describe('when buy grid trade index is null', () => {
        beforeEach(async () => {
          rawData = {
            ...baseRawData,
            symbolConfiguration: {
              candles: { limit: '100' },
              buy: {
                currentGridTradeIndex: -1,
                currentGridTrade: null,
                gridTrade: [],
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
                currentGridTradeIndex: 0,
                currentGridTrade: null,
                gridTrade: [],
                stopLoss: { maxLossPercentage: 0.8 },
                conservativeMode: {
                  enabled: false,
                  factor: 0.5
                }
              }
            },
            baseAssetBalance: { total: 0.001 },
            openOrders: [
              {
                orderId: 1,
                symbol: 'BTCUSDT',
                type: 'LIMIT',
                side: 'BUY',
                price: '7000.000',
                origQty: '0.005',
                time: 1615465601162
              },
              {
                orderId: 2,
                symbol: 'BTCUSDT',
                type: 'STOP_LOSS_LIMIT',
                side: 'BUY',
                price: '7100.000',
                origQty: '0.005',
                stopPrice: '7000.000',
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

        it('triggers expected value', () => {
          expect(result).toStrictEqual({
            ...rawData,
            baseAssetBalance: {
              total: 0.001,
              estimatedValue: 8.9,
              isLessThanMinNotionalValue: true
            },
            openOrders: [
              {
                orderId: 1,
                symbol: 'BTCUSDT',
                type: 'LIMIT',
                side: 'BUY',
                price: '7000.000',
                origQty: '0.005',
                time: 1615465601162,
                currentPrice: 8900,
                updatedAt: expect.any(Object)
              },
              {
                orderId: 2,
                symbol: 'BTCUSDT',
                type: 'STOP_LOSS_LIMIT',
                side: 'BUY',
                price: '7100.000',
                origQty: '0.005',
                stopPrice: '7000.000',
                time: 1615465601162,
                currentPrice: 8900,
                differenceToCancel: null,
                differenceToExecute: 21.34831460674157,
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
                currentPrice: 8900,
                differenceToCancel: null,
                differenceToExecute: -79.7752808988764,
                minimumProfit: 34.5,
                minimumProfitPercentage: 76.66666666666666,
                updatedAt: expect.any(Object)
              }
            ],
            indicators: {
              highestPrice: 10000,
              lowestPrice: 8893.03,
              athPrice: 9887.9
            },
            lastCandle: {
              symbol: 'BTCUSDT',
              close: '8900'
            },
            buy: {
              currentPrice: 8900,
              limitPrice: null,
              highestPrice: 10000,
              lowestPrice: 8893.03,
              athPrice: 9887.9,
              athRestrictionPrice: 8899.11,
              nextBestBuyAmount: null,
              nextBestBuyCalculation: {
                buyTrigger: 0.9888888888888889,
                currentPrice: 8900,
                hasObviousManualTrade: false,
                isSingleSellGrid: false,
                lastBuyPrice: 9000,
                sellTrigger: null,
                totalBoughtAmount: 0,
                totalBoughtQty: 0
              },
              triggerPrice: null,
              difference: null,
              openOrders: [
                {
                  orderId: 1,
                  symbol: 'BTCUSDT',
                  type: 'LIMIT',
                  side: 'BUY',
                  price: '7000.000',
                  origQty: '0.005',
                  time: 1615465601162,
                  currentPrice: 8900,
                  updatedAt: expect.any(Object)
                },
                {
                  orderId: 2,
                  symbol: 'BTCUSDT',
                  type: 'STOP_LOSS_LIMIT',
                  side: 'BUY',
                  price: '7100.000',
                  origQty: '0.005',
                  stopPrice: '7000.000',
                  time: 1615465601162,
                  currentPrice: 8900,
                  differenceToCancel: null,
                  differenceToExecute: 21.34831460674157,
                  updatedAt: expect.any(Object)
                }
              ],
              processMessage: '',
              updatedAt: expect.any(Object)
            },
            sell: {
              currentPrice: 8900,
              limitPrice: null,
              lastBuyPrice: 9000,
              triggerPrice: null,
              difference: null,
              currentProfit: -0.1,
              currentProfitPercentage: -1.1111111111111072,
              stopLossDifference: 19.10112359550562,
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
                  currentPrice: 8900,
                  differenceToCancel: null,
                  differenceToExecute: -79.7752808988764,
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
          rawData = {
            ...baseRawData,
            symbolConfiguration: {
              candles: { limit: '100' },
              buy: {
                currentGridTradeIndex: 0,
                currentGridTrade: {
                  triggerPercentage: 1.01,
                  limitPercentage: 1.021
                },
                gridTrade: [
                  {
                    triggerPercentage: 1.01,
                    limitPercentage: 1.021,
                    executed: false
                  },
                  {
                    triggerPercentage: 0.9,
                    limitPercentage: 1.046,
                    executed: false
                  }
                ],
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
                currentGridTradeIndex: 0,
                currentGridTrade: {
                  triggerPercentage: 1.06,
                  limitPercentage: 0.979
                },
                gridTrade: [
                  {
                    triggerPercentage: 1.06,
                    limitPercentage: 0.979,
                    executed: false
                  }
                ],
                stopLoss: { maxLossPercentage: 0.8 },
                conservativeMode: {
                  enabled: false,
                  factor: 0.5
                }
              }
            },
            baseAssetBalance: { total: 0.001 },
            openOrders: [
              {
                orderId: 1,
                symbol: 'BTCUSDT',
                type: 'LIMIT',
                side: 'BUY',
                price: '7000.000',
                origQty: '0.005',
                time: 1615465601162
              },
              {
                orderId: 2,
                symbol: 'BTCUSDT',
                type: 'STOP_LOSS_LIMIT',
                side: 'BUY',
                price: '7100.000',
                origQty: '0.005',
                stopPrice: '7000.000',
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
            ...rawData,
            baseAssetBalance: {
              total: 0.001,
              estimatedValue: 8.9,
              isLessThanMinNotionalValue: true
            },
            openOrders: [
              {
                orderId: 1,
                symbol: 'BTCUSDT',
                type: 'LIMIT',
                side: 'BUY',
                price: '7000.000',
                origQty: '0.005',
                time: 1615465601162,
                currentPrice: 8900,
                updatedAt: expect.any(Object)
              },
              {
                orderId: 2,
                symbol: 'BTCUSDT',
                type: 'STOP_LOSS_LIMIT',
                side: 'BUY',
                price: '7100.000',
                origQty: '0.005',
                stopPrice: '7000.000',
                time: 1615465601162,
                currentPrice: 8900,
                differenceToCancel: 22.966028018356088,
                differenceToExecute: 21.34831460674157,
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
                currentPrice: 8900,
                differenceToCancel: -82.4838461626746,
                differenceToExecute: -78.65168539325842,
                minimumProfit: 35,
                minimumProfitPercentage: 77.77777777777777,
                updatedAt: expect.any(Object)
              }
            ],
            indicators: {
              highestPrice: 10000,
              lowestPrice: 8893.03,
              athPrice: 9887.9
            },
            lastCandle: {
              symbol: 'BTCUSDT',
              close: '8900'
            },
            buy: {
              currentPrice: 8900,
              limitPrice: 9086.9,
              highestPrice: 10000,
              lowestPrice: 8893.03,
              nextBestBuyAmount: null,
              nextBestBuyCalculation: {
                buyTrigger: 0.9888888888888889,
                currentPrice: 8900,
                hasObviousManualTrade: true,
                isSingleSellGrid: true,
                lastBuyPrice: 9000,
                sellTrigger: 1.06,
                totalBoughtAmount: 0,
                totalBoughtQty: 0
              },
              athPrice: 9887.9,
              athRestrictionPrice: 8899.11,
              triggerPrice: 8981.9603,
              difference: -0.912499023180946,
              openOrders: [
                {
                  orderId: 1,
                  symbol: 'BTCUSDT',
                  type: 'LIMIT',
                  side: 'BUY',
                  price: '7000.000',
                  origQty: '0.005',
                  time: 1615465601162,
                  currentPrice: 8900,
                  updatedAt: expect.any(Object)
                },
                {
                  orderId: 2,
                  symbol: 'BTCUSDT',
                  type: 'STOP_LOSS_LIMIT',
                  side: 'BUY',
                  price: '7100.000',
                  origQty: '0.005',
                  stopPrice: '7000.000',
                  time: 1615465601162,
                  currentPrice: 8900,
                  differenceToCancel: 22.966028018356088,
                  differenceToExecute: 21.34831460674157,
                  updatedAt: expect.any(Object)
                }
              ],
              processMessage: '',
              updatedAt: expect.any(Object)
            },
            sell: {
              currentPrice: 8900,
              limitPrice: 8713.1,
              lastBuyPrice: 9000,
              triggerPrice: 9540,
              difference: -7.191011235955047,
              currentProfit: -0.1,
              currentProfitPercentage: -1.1111111111111072,
              stopLossDifference: 19.10112359550562,
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
                  currentPrice: 8900,
                  differenceToCancel: -82.4838461626746,
                  differenceToExecute: -78.65168539325842,
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
          rawData = {
            ...baseRawData,
            symbolConfiguration: {
              candles: { limit: '100' },
              buy: {
                currentGridTradeIndex: 1,
                currentGridTrade: {
                  triggerPercentage: 1.01,
                  limitPercentage: 1.021
                },
                gridTrade: [
                  {
                    triggerPercentage: 1.01,
                    limitPercentage: 1.021,
                    executed: true,
                    executedOrder: { cummulativeQuoteQty: 9000, executedQty: 1 }
                  },
                  {
                    triggerPercentage: 0.9,
                    limitPercentage: 1.046,
                    executed: false,
                    executedOrder: null
                  }
                ],
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
                currentGridTradeIndex: 0,
                currentGridTrade: {
                  triggerPercentage: 1.06,
                  limitPercentage: 0.979
                },
                gridTrade: [
                  {
                    triggerPercentage: 1.06,
                    limitPercentage: 0.979,
                    executed: false
                  }
                ],
                stopLoss: { maxLossPercentage: 0.8 },
                conservativeMode: {
                  enabled: false,
                  factor: 0.5
                }
              }
            },
            baseAssetBalance: { total: 1 },
            openOrders: [
              {
                orderId: 1,
                symbol: 'BTCUSDT',
                type: 'LIMIT',
                side: 'BUY',
                price: '7000.000',
                origQty: '0.005',
                time: 1615465601162
              },
              {
                orderId: 2,
                symbol: 'BTCUSDT',
                type: 'STOP_LOSS_LIMIT',
                side: 'BUY',
                price: '7100.000',
                origQty: '0.005',
                stopPrice: '7000.000',
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
            ...rawData,
            baseAssetBalance: {
              total: 1,
              estimatedValue: 8900,
              isLessThanMinNotionalValue: false
            },
            openOrders: [
              {
                orderId: 1,
                symbol: 'BTCUSDT',
                type: 'LIMIT',
                side: 'BUY',
                price: '7000.000',
                origQty: '0.005',
                time: 1615465601162,
                currentPrice: 8900,
                updatedAt: expect.any(Object)
              },
              {
                orderId: 2,
                symbol: 'BTCUSDT',
                type: 'STOP_LOSS_LIMIT',
                side: 'BUY',
                price: '7100.000',
                origQty: '0.005',
                stopPrice: '7000.000',
                time: 1615465601162,
                currentPrice: 8900,
                differenceToCancel: 22.966028018356088,
                differenceToExecute: 21.34831460674157,
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
                currentPrice: 8900,
                differenceToCancel: -82.4838461626746,
                differenceToExecute: -78.65168539325842,
                minimumProfit: 35,
                minimumProfitPercentage: 77.77777777777777,
                updatedAt: expect.any(Object)
              }
            ],
            indicators: {
              highestPrice: 10000,
              lowestPrice: 8893.03,
              athPrice: 9887.9
            },
            lastCandle: {
              symbol: 'BTCUSDT',
              close: '8900'
            },
            buy: {
              currentPrice: 8900,
              limitPrice: 9086.9,
              highestPrice: 10000,
              lowestPrice: 8893.03,
              nextBestBuyAmount: -7233.333333333327,
              nextBestBuyCalculation: {
                buyTrigger: 0.9888888888888889,
                currentPrice: 8900,
                hasObviousManualTrade: false,
                isSingleSellGrid: true,
                lastBuyPrice: 9000,
                sellTrigger: 1.06,
                totalBoughtAmount: 9000,
                totalBoughtQty: 1
              },
              athPrice: 9887.9,
              athRestrictionPrice: 8899.11,
              triggerPrice: 9090,
              difference: -2.0902090209020896,
              openOrders: [
                {
                  orderId: 1,
                  symbol: 'BTCUSDT',
                  type: 'LIMIT',
                  side: 'BUY',
                  price: '7000.000',
                  origQty: '0.005',
                  time: 1615465601162,
                  currentPrice: 8900,
                  updatedAt: expect.any(Object)
                },
                {
                  orderId: 2,
                  symbol: 'BTCUSDT',
                  type: 'STOP_LOSS_LIMIT',
                  side: 'BUY',
                  price: '7100.000',
                  origQty: '0.005',
                  stopPrice: '7000.000',
                  time: 1615465601162,
                  currentPrice: 8900,
                  differenceToCancel: 22.966028018356088,
                  differenceToExecute: 21.34831460674157,
                  updatedAt: expect.any(Object)
                }
              ],
              processMessage: '',
              updatedAt: expect.any(Object)
            },
            sell: {
              currentPrice: 8900,
              limitPrice: 8713.1,
              lastBuyPrice: 9000,
              triggerPrice: 9540,
              difference: -7.191011235955047,
              currentProfit: -100,
              currentProfitPercentage: -1.1111111111111072,
              stopLossDifference: 19.10112359550562,
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
                  currentPrice: 8900,
                  differenceToCancel: -82.4838461626746,
                  differenceToExecute: -78.65168539325842,
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
          rawData = {
            ...baseRawData,
            symbolConfiguration: {
              candles: { limit: '100' },
              buy: {
                currentGridTradeIndex: 1,
                currentGridTrade: {
                  triggerPercentage: 1.01,
                  limitPercentage: 1.021
                },
                gridTrade: [
                  {
                    triggerPercentage: 1.01,
                    limitPercentage: 1.021,
                    executed: true,
                    executedOrder: { cummulativeQuoteQty: 9000, executedQty: 1 }
                  },
                  {
                    triggerPercentage: 0.9,
                    limitPercentage: 1.046,
                    executed: false
                  }
                ],
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
                currentGridTradeIndex: 0,
                currentGridTrade: {
                  triggerPercentage: 1.06,
                  limitPercentage: 0.979
                },
                gridTrade: [
                  {
                    triggerPercentage: 1.06,
                    limitPercentage: 0.979,
                    executed: false
                  }
                ],
                stopLoss: { maxLossPercentage: 0.8 },
                conservativeMode: {
                  enabled: true,
                  factor: 0.5
                }
              }
            },
            baseAssetBalance: { total: 1 },
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
            ...rawData,
            baseAssetBalance: {
              total: 1,
              estimatedValue: 8900,
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
                currentPrice: 8900,
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
                currentPrice: 8900,
                differenceToCancel: -77.17813555778099,
                differenceToExecute: -80.89887640449437,
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
                currentPrice: 8900,
                differenceToCancel: -82.4838461626746,
                differenceToExecute: -78.65168539325842,
                minimumProfit: 35,
                minimumProfitPercentage: 77.77777777777777,
                updatedAt: expect.any(Object)
              }
            ],
            indicators: {
              highestPrice: 10000,
              lowestPrice: 8893.03,
              athPrice: 9887.9
            },
            lastCandle: {
              symbol: 'BTCUSDT',
              close: '8900'
            },
            buy: {
              currentPrice: 8900,
              limitPrice: 9086.9,
              highestPrice: 10000,
              lowestPrice: 8893.03,
              nextBestBuyAmount: -5566.6666666666615,
              nextBestBuyCalculation: {
                buyTrigger: 0.9888888888888889,
                currentPrice: 8900,
                hasObviousManualTrade: false,
                isSingleSellGrid: true,
                lastBuyPrice: 9000,
                sellTrigger: 1.03,
                totalBoughtAmount: 9000,
                totalBoughtQty: 1
              },
              athPrice: 9887.9,
              athRestrictionPrice: 8899.11,
              triggerPrice: 9090,
              difference: -2.0902090209020896,
              openOrders: [
                {
                  orderId: 1,
                  symbol: 'BTCUSDT',
                  type: 'LIMIT',
                  side: 'BUY',
                  price: '13000.000',
                  origQty: '0.005',
                  time: 1615465601162,
                  currentPrice: 8900,
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
                  currentPrice: 8900,
                  differenceToCancel: -77.17813555778099,
                  differenceToExecute: -80.89887640449437,
                  updatedAt: expect.any(Object)
                }
              ],
              processMessage: '',
              updatedAt: expect.any(Object)
            },
            sell: {
              currentPrice: 8900,
              limitPrice: 8713.1,
              lastBuyPrice: 9000,
              triggerPrice: 9540,
              difference: -7.191011235955047,
              currentProfit: -100,
              currentProfitPercentage: -1.1111111111111072,
              stopLossDifference: 19.10112359550562,
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
                  currentPrice: 8900,
                  differenceToCancel: -82.4838461626746,
                  differenceToExecute: -78.65168539325842,
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

      describe('when buy grid trade index is 2 with conservative mode enabled', () => {
        beforeEach(async () => {
          clearMocks();

          mockLastBuyPrice({ lastBuyPrice: 9966.66666666667, quantity: 1.5 });

          mockLatestCandle(8900);

          step = require('../get-indicators');

          rawData = {
            ...baseRawData,
            symbolConfiguration: {
              candles: { limit: '100' },
              buy: {
                currentGridTradeIndex: 2,
                currentGridTrade: {
                  triggerPercentage: 1.01,
                  limitPercentage: 1.021
                },
                gridTrade: [
                  {
                    triggerPercentage: 1.01,
                    limitPercentage: 1.021,
                    executed: true,
                    executedOrder: {
                      cummulativeQuoteQty: 10000,
                      executedQty: 1
                    }
                  },
                  {
                    triggerPercentage: 0.9,
                    limitPercentage: 1.046,
                    executed: true,
                    executedOrder: {
                      cummulativeQuoteQty: 9900,
                      executedQty: 0.5
                    }
                  },
                  {
                    triggerPercentage: 0.9,
                    limitPercentage: 1.046,
                    executed: false
                  }
                ],
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
                currentGridTradeIndex: 0,
                currentGridTrade: {
                  triggerPercentage: 1.06,
                  limitPercentage: 0.979
                },
                gridTrade: [
                  {
                    triggerPercentage: 1.06,
                    limitPercentage: 0.979,
                    executed: false
                  }
                ],
                stopLoss: { maxLossPercentage: 1.5 },
                conservativeMode: {
                  enabled: true,
                  factor: 0.5
                }
              }
            },
            baseAssetBalance: { total: 1.5 },
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
            ...rawData,
            baseAssetBalance: {
              total: 1.5,
              estimatedValue: 13350,
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
                currentPrice: 8900,
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
                currentPrice: 8900,
                differenceToCancel: -77.17813555778099,
                differenceToExecute: -80.89887640449437,
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
                currentPrice: 8900,
                differenceToCancel: -82.4838461626746,
                differenceToExecute: -78.65168539325842,
                minimumProfit: 30.166666666666654,
                minimumProfitPercentage: 60.535117056856144,
                updatedAt: expect.any(Object)
              }
            ],
            indicators: {
              highestPrice: 10000,
              lowestPrice: 8893.03,
              athPrice: 9887.9
            },
            lastCandle: {
              symbol: 'BTCUSDT',
              close: '8900'
            },
            buy: {
              currentPrice: 8900,
              limitPrice: 9086.9,
              highestPrice: 10000,
              lowestPrice: 8893.03,
              nextBestBuyAmount: 423316.666666663,
              nextBestBuyCalculation: {
                buyTrigger: 0.8929765886287623,
                currentPrice: 8900,
                hasObviousManualTrade: false,
                isSingleSellGrid: true,
                lastBuyPrice: 9966.66666666667,
                sellTrigger: 1.0150000000000001,
                totalBoughtAmount: 19900,
                totalBoughtQty: 1.5
              },
              athPrice: 9887.9,
              athRestrictionPrice: 8899.11,
              triggerPrice: 10066.333333333336,
              difference: -11.586476373389864,
              openOrders: [
                {
                  orderId: 1,
                  symbol: 'BTCUSDT',
                  type: 'LIMIT',
                  side: 'BUY',
                  price: '13000.000',
                  origQty: '0.005',
                  time: 1615465601162,
                  currentPrice: 8900,
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
                  currentPrice: 8900,
                  differenceToCancel: -77.17813555778099,
                  differenceToExecute: -80.89887640449437,
                  updatedAt: expect.any(Object)
                }
              ],
              processMessage: '',
              updatedAt: expect.any(Object)
            },
            sell: {
              currentPrice: 8900,
              limitPrice: 8713.1,
              lastBuyPrice: 9966.66666666667,
              triggerPrice: 10265.66666666667,
              difference: -15.344569288389543,
              currentProfit: -1600.0000000000045,
              currentProfitPercentage: -10.702341137123772,
              stopLossDifference: -67.97752808988768,
              stopLossTriggerPrice: 14950.000000000004,
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
                  currentPrice: 8900,
                  differenceToCancel: -82.4838461626746,
                  differenceToExecute: -78.65168539325842,
                  minimumProfit: 30.166666666666654,
                  minimumProfitPercentage: 60.535117056856144,
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
        mockLastBuyPrice(null);

        mockLatestCandle(9000);

        step = require('../get-indicators');

        rawData = {
          ...baseRawData,
          symbolConfiguration: {
            candles: { limit: '100' },
            buy: {
              currentGridTradeIndex: 0,
              currentGridTrade: {
                triggerPercentage: 1.01,
                limitPercentage: 1.021
              },
              gridTrade: [
                {
                  triggerPercentage: 1.01,
                  limitPercentage: 1.021,
                  executed: false
                },
                {
                  triggerPercentage: 0.9,
                  limitPercentage: 1.046,
                  executed: false
                }
              ],
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
              currentGridTradeIndex: 0,
              currentGridTrade: {
                triggerPercentage: 1.06,
                limitPercentage: 0.979
              },
              gridTrade: [
                {
                  triggerPercentage: 1.06,
                  limitPercentage: 0.979,
                  executed: false
                }
              ],
              stopLoss: { maxLossPercentage: 0.8 },
              conservativeMode: {
                enabled: false,
                factor: 0.5
              }
            }
          },
          baseAssetBalance: {
            total: 0.001
          },
          openOrders: [
            {
              orderId: 1,
              symbol: 'BTCUSDT',
              type: 'LIMIT',
              side: 'BUY',
              price: '7000.000',
              origQty: '0.06',
              time: 1615465601162
            },
            {
              orderId: 2,
              symbol: 'BTCUSDT',
              type: 'STOP_LOSS_LIMIT',
              side: 'BUY',
              price: '6000.000',
              origQty: '0.05',
              stopPrice: '6100.000',
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

      it('triggers expected value', () => {
        expect(result).toStrictEqual({
          ...rawData,
          baseAssetBalance: {
            total: 0.001,
            estimatedValue: 9,
            isLessThanMinNotionalValue: true
          },
          openOrders: [
            {
              orderId: 1,
              symbol: 'BTCUSDT',
              type: 'LIMIT',
              side: 'BUY',
              price: '7000.000',
              origQty: '0.06',
              time: 1615465601162,
              currentPrice: 9000,
              updatedAt: expect.any(Object)
            },
            {
              orderId: 2,
              symbol: 'BTCUSDT',
              type: 'STOP_LOSS_LIMIT',
              side: 'BUY',
              price: '6000.000',
              origQty: '0.05',
              stopPrice: '6100.000',
              time: 1615465601162,
              currentPrice: 9000,
              differenceToExecute: 32.22222222222222,
              differenceToCancel: 33.61628033518337,
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
              currentPrice: 9000,
              differenceToExecute: -77.77777777777777,
              differenceToCancel: null,
              minimumProfit: null,
              minimumProfitPercentage: null,
              updatedAt: expect.any(Object)
            }
          ],
          indicators: {
            highestPrice: 10000,
            lowestPrice: 8893.03,
            athPrice: 9999
          },
          lastCandle: {
            symbol: 'BTCUSDT',
            close: '9000'
          },
          buy: {
            currentPrice: 9000,
            limitPrice: 9189,
            highestPrice: 10000,
            lowestPrice: 8893.03,
            nextBestBuyAmount: null,
            nextBestBuyCalculation: null,
            triggerPrice: 8981.9603,
            athPrice: 9999,
            athRestrictionPrice: 8999.1,
            difference: 0.2008436844237682,
            openOrders: [
              {
                orderId: 1,
                symbol: 'BTCUSDT',
                type: 'LIMIT',
                side: 'BUY',
                price: '7000.000',
                origQty: '0.06',
                time: 1615465601162,
                currentPrice: 9000,
                updatedAt: expect.any(Object)
              },
              {
                orderId: 2,
                symbol: 'BTCUSDT',
                type: 'STOP_LOSS_LIMIT',
                side: 'BUY',
                price: '6000.000',
                origQty: '0.05',
                stopPrice: '6100.000',
                time: 1615465601162,
                currentPrice: 9000,
                differenceToExecute: 32.22222222222222,
                differenceToCancel: 33.61628033518337,
                updatedAt: expect.any(Object)
              }
            ],
            processMessage: '',
            updatedAt: expect.any(Object)
          },
          sell: {
            currentPrice: 9000,
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
                price: '15900.000',
                origQty: '0.005',
                stopPrice: '16000.000',
                time: 1615465601162,
                currentPrice: 9000,
                differenceToExecute: -77.77777777777777,
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
        mockLastBuyPrice(null);

        mockLatestCandle(15555.09);

        step = require('../get-indicators');

        rawData = {
          ...baseRawData,
          symbolConfiguration: {
            candles: { limit: '100' },
            buy: {
              currentGridTradeIndex: 0,
              currentGridTrade: {
                triggerPercentage: 1.01,
                limitPercentage: 1.011
              },
              gridTrade: [
                {
                  triggerPercentage: 1.01,
                  limitPercentage: 1.011,
                  executed: false
                },
                {
                  triggerPercentage: 0.9,
                  limitPercentage: 1.046,
                  executed: false
                }
              ],
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
              currentGridTradeIndex: 0,
              currentGridTrade: {
                triggerPercentage: 0.99,
                limitPercentage: 0.98
              },
              gridTrade: [
                {
                  triggerPercentage: 0.99,
                  limitPercentage: 0.98,
                  executed: false
                }
              ],
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
          ...rawData,
          baseAssetBalance: {
            total: 0.1,
            estimatedValue: 1555.509,
            isLessThanMinNotionalValue: false
          },
          openOrders: [],
          indicators: {
            highestPrice: 17110.599000000002,
            lowestPrice: 8893.03,
            athPrice: 17281.704990000002
          },
          lastCandle: {
            symbol: 'BTCUSDT',
            close: '15555.09'
          },
          buy: {
            currentPrice: 15555.09,
            limitPrice: 15726.195989999998,
            highestPrice: 17110.599000000002,
            lowestPrice: 8893.03,
            nextBestBuyAmount: null,
            nextBestBuyCalculation: null,
            athPrice: 17281.704990000002,
            athRestrictionPrice: 15553.534491000002,
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
        mockLastBuyPrice(null);
        mockLatestCandle(15555.09);

        mongoMock.findAll = jest.fn().mockResolvedValue([]);

        step = require('../get-indicators');

        rawData = {
          ...baseRawData,
          symbolConfiguration: {
            candles: { limit: '100' },
            buy: {
              currentGridTradeIndex: 0,
              currentGridTrade: {
                triggerPercentage: 1.01,
                limitPercentage: 1.021
              },
              gridTrade: [
                {
                  triggerPercentage: 1.01,
                  limitPercentage: 1.021,
                  executed: false
                },
                {
                  triggerPercentage: 0.9,
                  limitPercentage: 1.046,
                  executed: false
                }
              ],
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
              currentGridTradeIndex: 0,
              currentGridTrade: {
                triggerPercentage: 1.06,
                limitPercentage: 0.979
              },
              gridTrade: [
                {
                  triggerPercentage: 1.06,
                  limitPercentage: 0.979,
                  executed: false
                }
              ],
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
          ...rawData,
          baseAssetBalance: { total: 0.1 },
          openOrders: [],
          saveToCache: false
        });
      });
    });

    describe('when there is no latest candle cache', () => {
      beforeEach(async () => {
        mockLastBuyPrice(null);
        mockLatestCandle(9899.05);

        cacheMock.hget = jest.fn().mockResolvedValue(null);

        step = require('../get-indicators');

        rawData = {
          ...baseRawData,
          symbolConfiguration: {
            candles: { limit: '100' },
            buy: {
              currentGridTradeIndex: 0,
              currentGridTrade: {
                triggerPercentage: 1.01,
                limitPercentage: 1.021
              },
              gridTrade: [
                {
                  triggerPercentage: 1.01,
                  limitPercentage: 1.021,
                  executed: false
                },
                {
                  triggerPercentage: 0.9,
                  limitPercentage: 1.046,
                  executed: false
                }
              ],
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
              currentGridTradeIndex: 0,
              currentGridTrade: {
                triggerPercentage: 1.06,
                limitPercentage: 0.979
              },
              gridTrade: [
                {
                  triggerPercentage: 1.06,
                  limitPercentage: 0.979,
                  executed: false
                }
              ],
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
          ...rawData,
          baseAssetBalance: {
            total: 0.1,
            estimatedValue: 989.905,
            isLessThanMinNotionalValue: false
          },
          openOrders: [],
          indicators: {
            highestPrice: 10888.955,
            lowestPrice: 8893.03,
            athPrice: 10997.84455
          },
          lastCandle: {
            eventType: '24hrMiniTicker',
            eventTime: undefined,
            symbol: 'BTCUSDT',
            close: 9899.05
          },
          buy: {
            currentPrice: 9899.05,
            limitPrice: 10106.930049999999,
            highestPrice: 10888.955,
            lowestPrice: 8893.03,
            nextBestBuyAmount: null,
            nextBestBuyCalculation: null,
            athPrice: 10997.84455,
            athRestrictionPrice: 9898.060095,
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
        mockLastBuyPrice(null);

        mockLatestCandle(9899.05);

        cacheMock.hget = jest.fn().mockImplementation((hash, key) => {
          if (
            hash === 'trailing-trade-symbols' &&
            key === 'BTCUSDT-latest-candle'
          ) {
            return JSON.stringify({
              symbol: 'BTCUSDT',
              close: '9899.05'
            });
          }

          return null;
        });

        step = require('../get-indicators');
        rawData = {
          ...baseRawData,
          symbolConfiguration: {
            candles: { limit: '100' },
            buy: {
              currentGridTradeIndex: 0,
              currentGridTrade: {
                triggerPercentage: 1.01,
                limitPercentage: 1.021
              },
              gridTrade: [
                {
                  triggerPercentage: 1.01,
                  limitPercentage: 1.021,
                  executed: false
                },
                {
                  triggerPercentage: 0.9,
                  limitPercentage: 1.046,
                  executed: false
                }
              ],
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
              currentGridTradeIndex: 0,
              currentGridTrade: {
                triggerPercentage: 1.06,
                limitPercentage: 0.979
              },
              gridTrade: [
                {
                  triggerPercentage: 1.06,
                  limitPercentage: 0.979,
                  executed: false
                }
              ],
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
          ...rawData,
          baseAssetBalance: {
            total: 0.1,
            estimatedValue: 989.905,
            isLessThanMinNotionalValue: false
          },
          openOrders: [],
          indicators: {
            highestPrice: 10888.955,
            lowestPrice: 8893.03,
            athPrice: 10997.84455
          },
          lastCandle: {
            symbol: 'BTCUSDT',
            close: '9899.05'
          },
          buy: {
            currentPrice: 9899.05,
            limitPrice: 10106.930049999999,
            highestPrice: 10888.955,
            lowestPrice: 8893.03,
            nextBestBuyAmount: null,
            nextBestBuyCalculation: null,
            triggerPrice: 8981.9603,
            athPrice: 10997.84455,
            athRestrictionPrice: 9898.060095,
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
  });
});
