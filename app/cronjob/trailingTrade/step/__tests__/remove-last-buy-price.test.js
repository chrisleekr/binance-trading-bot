/* eslint-disable global-require */

describe('remove-last-buy-price.js', () => {
  let result;
  let rawData;

  let cacheMock;
  let mongoMock;
  let slackMock;
  let loggerMock;

  let mockGetAndCacheOpenOrdersForSymbol;
  let mockGetAPILimit;
  let mockIsActionDisabled;

  describe('execute', () => {
    beforeEach(() => {
      jest.clearAllMocks().resetModules();
    });

    beforeEach(async () => {
      const { mongo, cache, slack, logger } = require('../../../../helpers');

      mongoMock = mongo;
      cacheMock = cache;
      slackMock = slack;
      loggerMock = logger;

      mongoMock.deleteOne = jest.fn().mockResolvedValue(true);
      slackMock.sendMessage = jest.fn().mockResolvedValue(true);
      cacheMock.get = jest.fn().mockResolvedValue(null);

      mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([]);
      mockGetAPILimit = jest.fn().mockResolvedValue(10);
      mockIsActionDisabled = jest.fn().mockResolvedValue({
        isDiabled: false,
        ttl: -2
      });
    });

    describe('when symbol is locked`', () => {
      beforeEach(async () => {
        jest.mock('../../../trailingTradeHelper/common', () => ({
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
          isActionDisabled: mockIsActionDisabled,
          getAPILimit: mockGetAPILimit
        }));

        const step = require('../remove-last-buy-price');

        rawData = {
          action: 'not-determined',
          isLocked: true,
          symbol: 'BTCUPUSDT',
          symbolConfiguration: {
            buy: { lastBuyPriceRemoveThreshold: 10 }
          },
          symbolInfo: {
            filterLotSize: {
              stepSize: '0.01000000',
              minQty: '0.01000000'
            },
            filterMinNotional: {
              minNotional: '10.00000000'
            }
          },
          openOrders: [],
          baseAssetBalance: {
            free: 0,
            locked: 0
          },
          sell: {
            currentPrice: 200,
            lastBuyPrice: null
          }
        };

        result = await step.execute(loggerMock, rawData);
      });

      it('does not trigger mongo.deleteOne', () => {
        expect(mongoMock.deleteOne).not.toHaveBeenCalled();
      });

      it('returns expected data', () => {
        expect(result).toStrictEqual(rawData);
      });
    });

    describe('when action is not `not-determined`', () => {
      beforeEach(async () => {
        jest.mock('../../../trailingTradeHelper/common', () => ({
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
          isActionDisabled: mockIsActionDisabled,
          getAPILimit: mockGetAPILimit
        }));

        const step = require('../remove-last-buy-price');

        rawData = {
          action: 'buy',
          isLocked: false,
          symbol: 'BTCUPUSDT',
          symbolConfiguration: {
            buy: { lastBuyPriceRemoveThreshold: 10 }
          },
          symbolInfo: {
            filterLotSize: {
              stepSize: '0.01000000',
              minQty: '0.01000000'
            },
            filterMinNotional: {
              minNotional: '10.00000000'
            }
          },
          openOrders: [],
          baseAssetBalance: {
            free: 0,
            locked: 0
          },
          sell: {
            currentPrice: 200,
            lastBuyPrice: null
          }
        };

        result = await step.execute(loggerMock, rawData);
      });

      it('does not trigger mongo.deleteOne', () => {
        expect(mongoMock.deleteOne).not.toHaveBeenCalled();
      });

      it('returns expected data', () => {
        expect(result).toStrictEqual(rawData);
      });
    });

    describe('when last buy order exists', () => {
      beforeEach(async () => {
        jest.mock('../../../trailingTradeHelper/common', () => ({
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
          isActionDisabled: mockIsActionDisabled,
          getAPILimit: mockGetAPILimit
        }));

        cacheMock.get = jest.fn().mockResolvedValue(
          JSON.stringify({
            orderId: 123
          })
        );

        const step = require('../remove-last-buy-price');

        rawData = {
          action: 'not-determined',
          isLocked: false,
          symbol: 'BTCUPUSDT',
          symbolConfiguration: {
            buy: { lastBuyPriceRemoveThreshold: 10 }
          },
          symbolInfo: {
            filterLotSize: {
              stepSize: '0.01000000',
              minQty: '0.01000000'
            },
            filterMinNotional: {
              minNotional: '10.00000000'
            }
          },
          openOrders: [],
          baseAssetBalance: {
            free: 0,
            locked: 0
          },
          sell: {
            currentPrice: 200,
            lastBuyPrice: null
          }
        };

        result = await step.execute(loggerMock, rawData);
      });

      it('does not trigger mongo.deleteOne', () => {
        expect(mongoMock.deleteOne).not.toHaveBeenCalled();
      });

      it('returns expected data', () => {
        expect(result).toStrictEqual(rawData);
      });
    });

    describe('when last buy price is not set', () => {
      beforeEach(async () => {
        jest.mock('../../../trailingTradeHelper/common', () => ({
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
          isActionDisabled: mockIsActionDisabled,
          getAPILimit: mockGetAPILimit
        }));

        const step = require('../remove-last-buy-price');

        rawData = {
          action: 'not-determined',
          isLocked: false,
          symbol: 'BTCUPUSDT',
          symbolConfiguration: {
            buy: { lastBuyPriceRemoveThreshold: 10 }
          },
          symbolInfo: {
            filterLotSize: {
              stepSize: '0.01000000',
              minQty: '0.01000000'
            },
            filterMinNotional: {
              minNotional: '10.00000000'
            }
          },
          openOrders: [],
          baseAssetBalance: {
            free: 0,
            locked: 0
          },
          sell: {
            currentPrice: 200,
            lastBuyPrice: null
          }
        };

        result = await step.execute(loggerMock, rawData);
      });

      it('does not trigger mongo.deleteOne', () => {
        expect(mongoMock.deleteOne).not.toHaveBeenCalled();
      });

      it('returns expected data', () => {
        expect(result).toStrictEqual(rawData);
      });
    });

    describe('when open orders exist', () => {
      beforeEach(async () => {
        jest.mock('../../../trailingTradeHelper/common', () => ({
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
          isActionDisabled: mockIsActionDisabled,
          getAPILimit: mockGetAPILimit
        }));

        const step = require('../remove-last-buy-price');

        rawData = {
          action: 'not-determined',
          isLocked: false,
          symbol: 'BTCUPUSDT',
          symbolConfiguration: {
            buy: { lastBuyPriceRemoveThreshold: 10 }
          },
          symbolInfo: {
            filterLotSize: {
              stepSize: '0.01000000',
              minQty: '0.01000000'
            },
            filterMinNotional: {
              minNotional: '10.00000000'
            }
          },
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
          baseAssetBalance: {
            free: 0,
            locked: 0
          },
          sell: {
            currentPrice: 200,
            lastBuyPrice: 190
          }
        };

        result = await step.execute(loggerMock, rawData);
      });

      it('does not trigger mongo.deleteOne', () => {
        expect(mongoMock.deleteOne).not.toHaveBeenCalled();
      });

      it('returns expected data', () => {
        expect(result).toStrictEqual(rawData);
      });
    });

    describe('when action is disabled', () => {
      beforeEach(async () => {
        mockIsActionDisabled = jest.fn().mockResolvedValue({
          isDisabled: true,
          canRemoveLastBuyPrice: false
        });

        jest.mock('../../../trailingTradeHelper/common', () => ({
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
          isActionDisabled: mockIsActionDisabled,
          getAPILimit: mockGetAPILimit
        }));

        const step = require('../remove-last-buy-price');

        rawData = {
          action: 'not-determined',
          isLocked: false,
          symbol: 'BTCUPUSDT',
          symbolConfiguration: {
            buy: { lastBuyPriceRemoveThreshold: 10 }
          },
          symbolInfo: {
            filterLotSize: {
              stepSize: '0.01000000',
              minQty: '0.01000000'
            },
            filterMinNotional: {
              minNotional: '10.00000000'
            }
          },
          openOrders: [],
          baseAssetBalance: {
            free: 0,
            locked: 0
          },
          sell: {
            currentPrice: 200,
            lastBuyPrice: 190
          }
        };

        result = await step.execute(loggerMock, rawData);
      });

      it('does not trigger mongo.deleteOne', () => {
        expect(mongoMock.deleteOne).not.toHaveBeenCalled();
      });

      it('returns expected data', () => {
        expect(result).toStrictEqual(rawData);
      });
    });

    describe('when quantity is not enough to sell', () => {
      describe('when found open orders at this point', () => {
        beforeEach(async () => {
          mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([
            {
              orderId: '123123123'
            }
          ]);

          jest.mock('../../../trailingTradeHelper/common', () => ({
            getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
            isActionDisabled: mockIsActionDisabled,
            getAPILimit: mockGetAPILimit
          }));

          const step = require('../remove-last-buy-price');

          rawData = {
            action: 'not-determined',
            isLocked: false,
            symbol: 'BTCUPUSDT',
            symbolConfiguration: {
              buy: { lastBuyPriceRemoveThreshold: 10 }
            },
            symbolInfo: {
              filterLotSize: {
                stepSize: '0.01000000',
                minQty: '0.01000000'
              },
              filterMinNotional: {
                minNotional: '10.00000000'
              }
            },
            openOrders: [],
            baseAssetBalance: {
              free: 0,
              locked: 0
            },
            sell: {
              currentPrice: 200,
              lastBuyPrice: 160
            }
          };

          result = await step.execute(loggerMock, rawData);
        });

        it('does not trigger mongo.deleteOne', () => {
          expect(mongoMock.deleteOne).not.toHaveBeenCalled();
        });

        it('returns expected data', () => {
          expect(result).toStrictEqual(rawData);
        });
      });

      describe('when cannot find open orders', () => {
        describe('ALPHABTC', () => {
          beforeEach(async () => {
            jest.mock('../../../trailingTradeHelper/common', () => ({
              getAndCacheOpenOrdersForSymbol:
                mockGetAndCacheOpenOrdersForSymbol,
              isActionDisabled: mockIsActionDisabled,
              getAPILimit: mockGetAPILimit
            }));

            const step = require('../remove-last-buy-price');

            rawData = {
              action: 'not-determined',
              isLocked: false,
              symbol: 'ALPHABTC',
              symbolConfiguration: {
                buy: { lastBuyPriceRemoveThreshold: 0.0001 }
              },
              symbolInfo: {
                filterLotSize: {
                  stepSize: '1.00000000',
                  minQty: '1.00000000'
                },
                filterMinNotional: {
                  minNotional: '0.00010000'
                }
              },
              openOrders: [],
              baseAssetBalance: {
                free: 1,
                locked: 0
              },
              sell: {
                currentPrice: 0.000038,
                lastBuyPrice: 0.00003179
              }
            };

            result = await step.execute(loggerMock, rawData);
          });

          it('triggers mongo.deleteOne', () => {
            expect(mongoMock.deleteOne).toHaveBeenCalledWith(
              loggerMock,
              'trailing-trade-symbols',
              { key: 'ALPHABTC-last-buy-price' }
            );
          });

          it('returns expected data', () => {
            expect(result).toStrictEqual({
              ...rawData,
              ...{
                sell: {
                  currentPrice: 0.000038,
                  lastBuyPrice: 0.00003179,
                  processMessage:
                    'Balance is not enough to sell. Delete last buy price.',
                  updatedAt: expect.any(Object)
                }
              }
            });
          });
        });

        describe('BTCUPUSDT', () => {
          beforeEach(async () => {
            jest.mock('../../../trailingTradeHelper/common', () => ({
              getAndCacheOpenOrdersForSymbol:
                mockGetAndCacheOpenOrdersForSymbol,
              isActionDisabled: mockIsActionDisabled,
              getAPILimit: mockGetAPILimit
            }));

            const step = require('../remove-last-buy-price');

            rawData = {
              action: 'not-determined',
              isLocked: false,
              symbol: 'BTCUPUSDT',
              symbolConfiguration: {
                buy: { lastBuyPriceRemoveThreshold: 10 }
              },
              symbolInfo: {
                filterLotSize: {
                  stepSize: '0.01000000',
                  minQty: '0.01000000'
                },
                filterMinNotional: {
                  minNotional: '10.00000000'
                }
              },
              openOrders: [],
              baseAssetBalance: {
                free: 0,
                locked: 0
              },
              sell: {
                currentPrice: 200,
                lastBuyPrice: 160
              }
            };

            result = await step.execute(loggerMock, rawData);
          });

          it('triggers mongo.deleteOne', () => {
            expect(mongoMock.deleteOne).toHaveBeenCalledWith(
              loggerMock,
              'trailing-trade-symbols',
              { key: 'BTCUPUSDT-last-buy-price' }
            );
          });

          it('returns expected data', () => {
            expect(result).toStrictEqual({
              ...rawData,
              ...{
                sell: {
                  currentPrice: 200,
                  lastBuyPrice: 160,
                  processMessage:
                    'Balance is not enough to sell. Delete last buy price.',
                  updatedAt: expect.any(Object)
                }
              }
            });
          });
        });
      });
    });

    describe('when balance is less than minimum notional', () => {
      describe('when found open orders at this point', () => {
        beforeEach(async () => {
          mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([
            {
              orderId: '123123123'
            }
          ]);

          jest.mock('../../../trailingTradeHelper/common', () => ({
            getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
            isActionDisabled: mockIsActionDisabled,
            getAPILimit: mockGetAPILimit
          }));

          const step = require('../remove-last-buy-price');

          rawData = {
            action: 'not-determined',
            isLocked: false,
            symbol: 'BTCUPUSDT',
            symbolConfiguration: {
              buy: { lastBuyPriceRemoveThreshold: 10 }
            },
            symbolInfo: {
              filterLotSize: {
                stepSize: '0.01000000',
                minQty: '0.01000000'
              },
              filterMinNotional: {
                minNotional: '10.00000000'
              }
            },
            openOrders: [],
            baseAssetBalance: {
              free: 0,
              locked: 0.04
            },
            sell: {
              currentPrice: 200,
              lastBuyPrice: 160
            }
          };

          result = await step.execute(loggerMock, rawData);
        });

        it('does not trigger mongo.deleteOne', () => {
          expect(mongoMock.deleteOne).not.toHaveBeenCalled();
        });

        it('returns expected data', () => {
          expect(result).toStrictEqual(rawData);
        });
      });

      describe('when cannot find open orders', () => {
        describe('last buy price remove threshold is same as minimum notional', () => {
          beforeEach(async () => {
            jest.mock('../../../trailingTradeHelper/common', () => ({
              getAndCacheOpenOrdersForSymbol:
                mockGetAndCacheOpenOrdersForSymbol,
              isActionDisabled: mockIsActionDisabled,
              getAPILimit: mockGetAPILimit
            }));

            const step = require('../remove-last-buy-price');

            rawData = {
              action: 'not-determined',
              isLocked: false,
              symbol: 'BTCUPUSDT',
              symbolConfiguration: {
                buy: { lastBuyPriceRemoveThreshold: 10 }
              },
              symbolInfo: {
                filterLotSize: {
                  stepSize: '0.01000000',
                  minQty: '0.01000000'
                },
                filterMinNotional: {
                  minNotional: '10.00000000'
                }
              },
              openOrders: [],
              baseAssetBalance: {
                free: 0,
                locked: 0.04
              },
              sell: {
                currentPrice: 200,
                lastBuyPrice: 160
              }
            };

            result = await step.execute(loggerMock, rawData);
          });

          it('triggers mongo.deleteOne', () => {
            expect(mongoMock.deleteOne).toHaveBeenCalledWith(
              loggerMock,
              'trailing-trade-symbols',
              { key: 'BTCUPUSDT-last-buy-price' }
            );
          });

          it('returns expected data', () => {
            expect(result).toStrictEqual({
              ...rawData,
              ...{
                sell: {
                  currentPrice: 200,
                  lastBuyPrice: 160,
                  processMessage:
                    'Balance is less than the last buy price remove threshold. Delete last buy price.',
                  updatedAt: expect.any(Object)
                }
              }
            });
          });
        });

        describe('last buy price remove threshold is less than minimum notional', () => {
          beforeEach(async () => {
            jest.mock('../../../trailingTradeHelper/common', () => ({
              getAndCacheOpenOrdersForSymbol:
                mockGetAndCacheOpenOrdersForSymbol,
              isActionDisabled: mockIsActionDisabled,
              getAPILimit: mockGetAPILimit
            }));

            const step = require('../remove-last-buy-price');

            rawData = {
              action: 'not-determined',
              isLocked: false,
              symbol: 'BTCUPUSDT',
              symbolConfiguration: {
                buy: { lastBuyPriceRemoveThreshold: 5 }
              },
              symbolInfo: {
                filterLotSize: {
                  stepSize: '0.01000000',
                  minQty: '0.01000000'
                },
                filterMinNotional: {
                  minNotional: '10.00000000'
                }
              },
              openOrders: [],
              baseAssetBalance: {
                free: 0,
                locked: 0.04
              },
              sell: {
                currentPrice: 200,
                lastBuyPrice: 160
              }
            };

            result = await step.execute(loggerMock, rawData);
          });

          it('does not trigger mongo.deleteOne', () => {
            expect(mongoMock.deleteOne).not.toHaveBeenCalled();
          });

          it('returns expected data', () => {
            expect(result).toStrictEqual(rawData);
          });
        });
      });
    });

    describe('when there is enough balance', () => {
      beforeEach(async () => {
        jest.mock('../../../trailingTradeHelper/common', () => ({
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
          isActionDisabled: mockIsActionDisabled,
          getAPILimit: mockGetAPILimit
        }));

        const step = require('../remove-last-buy-price');

        rawData = {
          action: 'not-determined',
          isLocked: false,
          symbol: 'BTCUPUSDT',
          symbolConfiguration: {
            buy: { lastBuyPriceRemoveThreshold: 10 }
          },
          symbolInfo: {
            filterLotSize: {
              stepSize: '0.01000000',
              minQty: '0.01000000'
            },
            filterMinNotional: {
              minNotional: '10.00000000'
            }
          },
          openOrders: [],
          baseAssetBalance: {
            free: 0,
            locked: 0.2
          },
          sell: {
            currentPrice: 200,
            lastBuyPrice: 160
          }
        };

        result = await step.execute(loggerMock, rawData);
      });

      it('does not trigger mongo.deleteOne', () => {
        expect(mongoMock.deleteOne).not.toHaveBeenCalled();
      });

      it('returns expected data', () => {
        expect(result).toStrictEqual({
          ...rawData
        });
      });
    });
  });
});
