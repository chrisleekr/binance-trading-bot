const _ = require('lodash');
const config = require('config');
const configuration = require('../configuration');
const { logger, mongo, cache, PubSub } = require('../../../helpers');

jest.mock('config');
describe('configuration.js', () => {
  let result;

  beforeEach(async () => {
    jest.clearAllMocks().resetModules();
  });

  describe('saveGlobalConfiguration', () => {
    beforeEach(() => {
      cache.hdelall = jest.fn().mockResolvedValue(true);
      PubSub.publish = jest.fn().mockReturnValue(true);
      mongo.findOne = jest.fn().mockResolvedValueOnce({
        symbols: ['BTCUSDT', 'ETHUSDT'],
        candles: {
          interval: '1m',
          limit: 10
        },
        buy: {
          athRestriction: {
            candles: {
              candles: {
                interval: '1d',
                limit: 30
              }
            }
          }
        }
      });
      mongo.upsertOne = jest.fn().mockResolvedValue(true);
      mongo.dropIndex = jest.fn().mockResolvedValue(true);
      mongo.createIndex = jest.fn().mockResolvedValue(true);
    });

    describe('when old and new configuration are same', () => {
      beforeEach(async () => {
        result = await configuration.saveGlobalConfiguration(logger, {
          symbols: ['BTCUSDT', 'ETHUSDT'],
          candles: {
            interval: '1m',
            limit: 10
          },
          buy: {
            athRestriction: {
              candles: {
                candles: {
                  interval: '1d',
                  limit: 30
                }
              }
            }
          },
          botOptions: {
            logs: {
              deleteAfter: 30
            }
          }
        });
      });

      it('triggers cache.hdelall', () => {
        expect(cache.hdelall).toHaveBeenCalledWith(
          'trailing-trade-configurations:*'
        );
      });

      it('triggers mongo.upsertOne with expected value', () => {
        expect(mongo.upsertOne).toHaveBeenCalledWith(
          logger,
          'trailing-trade-common',
          { key: 'configuration' },
          {
            key: 'configuration',
            symbols: ['BTCUSDT', 'ETHUSDT'],
            candles: {
              interval: '1m',
              limit: 10
            },
            buy: {
              athRestriction: {
                candles: {
                  candles: {
                    interval: '1d',
                    limit: 30
                  }
                }
              }
            },
            botOptions: {
              logs: {
                deleteAfter: 30
              }
            }
          }
        );
      });

      it('do not trigger PubSub.publish', () => {
        expect(PubSub.publish).not.toHaveBeenCalledWith(
          'reset-all-websockets',
          true
        );
      });
    });

    describe('when symbols are different', () => {
      beforeEach(async () => {
        result = await configuration.saveGlobalConfiguration(logger, {
          symbols: ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'],
          candles: {
            interval: '1m',
            limit: 10
          },
          buy: {
            athRestriction: {
              candles: {
                candles: {
                  interval: '1d',
                  limit: 30
                }
              }
            }
          },
          botOptions: {
            logs: {
              deleteAfter: 30
            }
          }
        });
      });

      it('triggers PubSub.publish', () => {
        expect(PubSub.publish).toHaveBeenCalledWith(
          'reset-all-websockets',
          true
        );
      });
    });

    describe('when candles are different', () => {
      beforeEach(async () => {
        result = await configuration.saveGlobalConfiguration(logger, {
          symbols: ['BTCUSDT', 'ETHUSDT'],
          candles: {
            interval: '15m',
            limit: 100
          },
          buy: {
            athRestriction: {
              candles: {
                candles: {
                  interval: '1d',
                  limit: 30
                }
              }
            }
          },
          botOptions: {
            logs: {
              deleteAfter: 30
            }
          }
        });
      });

      it('triggers PubSub.publish', () => {
        expect(PubSub.publish).toHaveBeenCalledWith(
          'reset-all-websockets',
          true
        );
      });
    });

    describe('when ATH restriction candles are different', () => {
      beforeEach(async () => {
        result = await configuration.saveGlobalConfiguration(logger, {
          symbols: ['BTCUSDT', 'ETHUSDT'],
          candles: {
            interval: '1m',
            limit: 10
          },
          buy: {
            athRestriction: {
              candles: {
                candles: {
                  interval: '15m',
                  limit: 60
                }
              }
            }
          },
          botOptions: {
            logs: {
              deleteAfter: 30
            }
          }
        });
      });

      it('triggers PubSub.publish', () => {
        expect(PubSub.publish).toHaveBeenCalledWith(
          'reset-all-websockets',
          true
        );
      });
    });
  });

  describe('getGlobalConfiguration', () => {
    describe('when cannot find from mongodb', () => {
      beforeEach(async () => {
        cache.del = jest.fn().mockResolvedValue(true);
        mongo.upsertOne = jest.fn().mockResolvedValue(true);
        mongo.findOne = jest.fn((_logger, _collection, _filter) => null);
        mongo.dropIndex = jest.fn().mockResolvedValue(true);
        mongo.createIndex = jest.fn().mockResolvedValue(true);
        PubSub.publish = jest.fn().mockReturnValue(true);

        config.get = jest.fn(key => {
          if (key === 'jobs.trailingTrade') {
            return {
              enabled: true,
              symbols: ['BTCUSDT', 'BNBBTC', 'TRXUSDT'],
              sell: {
                stopLoss: {
                  enabled: true,
                  key: 'value'
                }
              },
              botOptions: {
                logs: {
                  deleteAfter: 30
                }
              }
            };
          }
          return null;
        });

        result = await configuration.getGlobalConfiguration(logger);
      });

      it('triggers mongo.upsertOne from saveGlobalConfiguration', () => {
        expect(mongo.upsertOne).toHaveBeenCalledWith(
          logger,
          'trailing-trade-common',
          { key: 'configuration' },
          {
            key: 'configuration',
            enabled: true,
            symbols: ['BTCUSDT', 'BNBBTC', 'TRXUSDT'],
            sell: {
              stopLoss: {
                enabled: true,
                key: 'value'
              }
            },
            botOptions: {
              logs: {
                deleteAfter: 30
              }
            }
          }
        );
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual({
          enabled: true,
          symbols: ['BTCUSDT', 'BNBBTC', 'TRXUSDT'],
          sell: {
            stopLoss: {
              enabled: true,
              key: 'value'
            }
          },
          botOptions: {
            logs: {
              deleteAfter: 30
            }
          }
        });
      });

      it('triggers mongo.upsertOne once', () => {
        expect(mongo.upsertOne).toHaveBeenCalledTimes(1);
      });
    });

    describe('when found from mongodb and configuration with stopLoss', () => {
      beforeEach(async () => {
        cache.del = jest.fn().mockResolvedValue(true);
        config.get = jest.fn(key => {
          if (key === 'jobs.trailingTrade') {
            return {
              enabled: true,
              cronTime: '* * * * * *',
              symbols: ['BTCUSDT', 'ETHUSDT', 'ETHBTC', 'XRPBTC'],
              candles: {
                interval: '1h',
                limit: 100
              },
              buy: {
                enabled: true,
                maxPurchaseAmount: -1,
                maxPurchaseAmounts: {},
                triggerPercentage: 1.0,
                stopPercentage: 1.02,
                limitPercentage: 1.021
              },
              sell: {
                enabled: true,
                triggerPercentage: 1.06,
                stopPercentage: 0.98,
                limitPercentage: 0.979,
                stopLoss: {
                  enabled: false,
                  maxLossPercentage: 0.8,
                  disableBuyMinutes: 360,
                  orderType: 'market'
                }
              },
              system: {
                temporaryDisableActionAfterConfirmingOrder: 20,
                checkManualBuyOrderPeriod: 10,
                refreshAccountInfoPeriod: 1
              }
            };
          }
          return null;
        });

        mongo.findOne = jest.fn((_logger, collection, filter) => {
          if (
            collection === 'trailing-trade-common' &&
            _.isEqual(filter, { key: 'configuration' })
          ) {
            return {
              enabled: true,
              cronTime: '* * * * * *',
              symbols: ['BNBUSDT', 'TRXUSDT', 'ETHBTC', 'XRPBTC'],
              candles: {
                interval: '30m',
                limit: 150
              },
              buy: {
                enabled: false,
                maxPurchaseAmount: -1,
                maxPurchaseAmounts: {},
                triggerPercentage: 1.05,
                stopPercentage: 1.08,
                limitPercentage: 1.081
              },
              sell: {
                enabled: false,
                triggerPercentage: 1.08,
                stopPercentage: 0.95,
                limitPercentage: 0.949
              },
              system: {
                temporaryDisableActionAfterConfirmingOrder: 10
              }
            };
          }
          return null;
        });

        result = await configuration.getGlobalConfiguration(logger);
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual({
          enabled: true,
          cronTime: '* * * * * *',
          symbols: ['BNBUSDT', 'TRXUSDT', 'ETHBTC', 'XRPBTC'],
          candles: { interval: '30m', limit: 150 },
          buy: {
            enabled: false,
            maxPurchaseAmount: -1,
            maxPurchaseAmounts: {},
            triggerPercentage: 1.05,
            stopPercentage: 1.08,
            limitPercentage: 1.081
          },
          sell: {
            enabled: false,
            triggerPercentage: 1.08,
            stopPercentage: 0.95,
            limitPercentage: 0.949,
            stopLoss: {
              enabled: false,
              maxLossPercentage: 0.8,
              disableBuyMinutes: 360,
              orderType: 'market'
            }
          },
          system: {
            temporaryDisableActionAfterConfirmingOrder: 10,
            checkManualBuyOrderPeriod: 10,
            refreshAccountInfoPeriod: 1
          }
        });
      });
    });
  });

  describe('getSymbolConfiguration', () => {
    describe('when symbol is not provided', () => {
      beforeEach(async () => {
        result = await configuration.getSymbolConfiguration(logger);
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({});
      });
    });

    describe('when cannot find from mongodb', () => {
      beforeEach(async () => {
        mongo.findOne = jest.fn((_logger, _collection, _filter) => null);

        result = await configuration.getSymbolConfiguration(logger, 'BTCUSDT');
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({});
      });
    });

    describe('when found from mongodb', () => {
      beforeEach(async () => {
        mongo.findOne = jest.fn((_logger, collection, filter) => {
          if (
            collection === 'trailing-trade-symbols' &&
            _.isEqual(filter, { key: 'BTCUSDT-configuration' })
          ) {
            return {
              myConfig: 'value',
              buy: {
                maxPurchaseAmount: 150
              }
            };
          }
          return null;
        });

        result = await configuration.getSymbolConfiguration(logger, 'BTCUSDT');
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({
          myConfig: 'value',
          buy: {
            maxPurchaseAmount: 150
          }
        });
      });
    });
  });

  describe('getSymbolGridTrade', () => {
    describe('when symbol is not provided', () => {
      beforeEach(async () => {
        result = await configuration.getSymbolGridTrade(logger);
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({});
      });
    });

    describe('when cannot find from mongodb', () => {
      beforeEach(async () => {
        mongo.findOne = jest.fn((_logger, _collection, _filter) => null);

        result = await configuration.getSymbolGridTrade(logger, 'BTCUSDT');
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({});
      });
    });

    describe('when found from mongodb', () => {
      beforeEach(async () => {
        mongo.findOne = jest.fn((_logger, collection, filter) => {
          if (
            collection === 'trailing-trade-grid-trade' &&
            _.isEqual(filter, { key: 'BTCUSDT' })
          ) {
            return {
              buy: [
                {
                  triggerPercentage: 1,
                  stopPercentage: 1.025,
                  limitPercentage: 1.026,
                  maxPurchaseAmount: 10,
                  executed: false,
                  executedOrder: null
                }
              ],
              sell: [
                {
                  triggerPercentage: 1.025,
                  stopPercentage: 0.985,
                  limitPercentage: 0.984,
                  quantityPercentage: 1,
                  quantityPercentages: {
                    USDT: 1
                  },
                  executed: false,
                  executedOrder: null
                }
              ]
            };
          }
          return null;
        });

        result = await configuration.getSymbolGridTrade(logger, 'BTCUSDT');
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({
          buy: [
            {
              triggerPercentage: 1,
              stopPercentage: 1.025,
              limitPercentage: 1.026,
              maxPurchaseAmount: 10,
              executed: false,
              executedOrder: null
            }
          ],
          sell: [
            {
              triggerPercentage: 1.025,
              stopPercentage: 0.985,
              limitPercentage: 0.984,
              quantityPercentage: 1,
              quantityPercentages: {
                USDT: 1
              },
              executed: false,
              executedOrder: null
            }
          ]
        });
      });
    });
  });

  describe('saveSymbolConfiguration', () => {
    describe('when symbol is not provided', () => {
      beforeEach(async () => {
        cache.hdel = jest.fn().mockResolvedValue(true);
        PubSub.publish = jest.fn().mockReturnValue(true);
        mongo.upsertOne = jest.fn().mockResolvedValue(true);

        result = await configuration.saveSymbolConfiguration(logger);
      });

      it('does not trigger cache.hdel', () => {
        expect(cache.hdel).not.toHaveBeenCalled();
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual({});
      });

      it('does not trigger reset-symbol-websockets', () => {
        expect(PubSub.publish).not.toHaveBeenCalled();
      });
    });

    describe('when symbol is provided', () => {
      describe('when all configurations are same', () => {
        beforeEach(async () => {
          PubSub.publish = jest.fn().mockReturnValue(true);
          cache.hdel = jest.fn().mockResolvedValue(true);
          mongo.findOne = jest.fn().mockResolvedValueOnce({
            symbols: ['BTCUSDT', 'ETHUSDT'],
            candles: {
              interval: '1m',
              limit: 10
            },
            buy: {
              athRestriction: {
                candles: {
                  candles: {
                    interval: '1d',
                    limit: 30
                  }
                }
              }
            }
          });
          mongo.upsertOne = jest.fn().mockResolvedValue(true);

          result = await configuration.saveSymbolConfiguration(
            logger,
            'BTCUSDT',
            {
              symbols: ['BTCUSDT', 'ETHUSDT'],
              candles: {
                interval: '1m',
                limit: 10
              },
              buy: {
                athRestriction: {
                  candles: {
                    candles: {
                      interval: '1d',
                      limit: 30
                    }
                  }
                }
              }
            }
          );
        });

        it('triggers mongo.upsertOne', () => {
          expect(mongo.upsertOne).toHaveBeenCalledWith(
            logger,
            'trailing-trade-symbols',
            { key: 'BTCUSDT-configuration' },
            {
              key: 'BTCUSDT-configuration',
              symbols: ['BTCUSDT', 'ETHUSDT'],
              candles: {
                interval: '1m',
                limit: 10
              },
              buy: {
                athRestriction: {
                  candles: {
                    candles: {
                      interval: '1d',
                      limit: 30
                    }
                  }
                }
              }
            }
          );
        });

        it('triggers cache.hdel', () => {
          expect(cache.hdel).toHaveBeenCalledWith(
            'trailing-trade-configurations',
            'BTCUSDT'
          );
        });

        it('does not trigger reset-symbol-websockets', () => {
          expect(PubSub.publish).not.toHaveBeenCalled();
        });
      });

      describe('when candles is different', () => {
        beforeEach(async () => {
          PubSub.publish = jest.fn().mockReturnValue(true);
          cache.hdel = jest.fn().mockResolvedValue(true);
          mongo.findOne = jest.fn().mockResolvedValueOnce({
            symbols: ['BTCUSDT', 'ETHUSDT'],
            candles: {
              interval: '5m',
              limit: 10
            },
            buy: {
              athRestriction: {
                candles: {
                  candles: {
                    interval: '1d',
                    limit: 30
                  }
                }
              }
            }
          });
          mongo.upsertOne = jest.fn().mockResolvedValue(true);

          result = await configuration.saveSymbolConfiguration(
            logger,
            'BTCUSDT',
            {
              symbols: ['BTCUSDT', 'ETHUSDT'],
              candles: {
                interval: '1m',
                limit: 10
              },
              buy: {
                athRestriction: {
                  candles: {
                    candles: {
                      interval: '1d',
                      limit: 30
                    }
                  }
                }
              }
            }
          );
        });

        it('triggers mongo.upsertOne', () => {
          expect(mongo.upsertOne).toHaveBeenCalledWith(
            logger,
            'trailing-trade-symbols',
            { key: 'BTCUSDT-configuration' },
            {
              key: 'BTCUSDT-configuration',
              symbols: ['BTCUSDT', 'ETHUSDT'],
              candles: {
                interval: '1m',
                limit: 10
              },
              buy: {
                athRestriction: {
                  candles: {
                    candles: {
                      interval: '1d',
                      limit: 30
                    }
                  }
                }
              }
            }
          );
        });

        it('triggers cache.hdel', () => {
          expect(cache.hdel).toHaveBeenCalledWith(
            'trailing-trade-configurations',
            'BTCUSDT'
          );
        });

        it('triggers reset-symbol-websockets', () => {
          expect(PubSub.publish).toHaveBeenCalledWith(
            'reset-symbol-websockets',
            'BTCUSDT'
          );
        });
      });

      describe('when athRestriction.candles is different', () => {
        beforeEach(async () => {
          PubSub.publish = jest.fn().mockReturnValue(true);
          cache.hdel = jest.fn().mockResolvedValue(true);
          mongo.findOne = jest.fn().mockResolvedValueOnce({
            symbols: ['BTCUSDT', 'ETHUSDT'],
            candles: {
              interval: '1m',
              limit: 10
            },
            buy: {
              athRestriction: {
                candles: {
                  candles: {
                    interval: '30m',
                    limit: 30
                  }
                }
              }
            }
          });
          mongo.upsertOne = jest.fn().mockResolvedValue(true);

          result = await configuration.saveSymbolConfiguration(
            logger,
            'BTCUSDT',
            {
              symbols: ['BTCUSDT', 'ETHUSDT'],
              candles: {
                interval: '1m',
                limit: 10
              },
              buy: {
                athRestriction: {
                  candles: {
                    candles: {
                      interval: '1d',
                      limit: 30
                    }
                  }
                }
              }
            }
          );
        });

        it('triggers mongo.upsertOne', () => {
          expect(mongo.upsertOne).toHaveBeenCalledWith(
            logger,
            'trailing-trade-symbols',
            { key: 'BTCUSDT-configuration' },
            {
              key: 'BTCUSDT-configuration',
              symbols: ['BTCUSDT', 'ETHUSDT'],
              candles: {
                interval: '1m',
                limit: 10
              },
              buy: {
                athRestriction: {
                  candles: {
                    candles: {
                      interval: '1d',
                      limit: 30
                    }
                  }
                }
              }
            }
          );
        });

        it('triggers cache.hdel', () => {
          expect(cache.hdel).toHaveBeenCalledWith(
            'trailing-trade-configurations',
            'BTCUSDT'
          );
        });

        it('triggers reset-symbol-websockets', () => {
          expect(PubSub.publish).toHaveBeenCalledWith(
            'reset-symbol-websockets',
            'BTCUSDT'
          );
        });
      });
    });
  });

  describe('saveSymbolGridTrade', () => {
    describe('when symbol is not provided', () => {
      beforeEach(async () => {
        cache.hdel = jest.fn().mockResolvedValue(true);
        mongo.upsertOne = jest.fn().mockResolvedValue(true);

        result = await configuration.saveSymbolGridTrade(logger);
      });

      it('does not trigger cache.hdel', () => {
        expect(cache.hdel).not.toHaveBeenCalled();
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual({});
      });
    });

    describe('when symbol is provided', () => {
      beforeEach(async () => {
        cache.hdel = jest.fn().mockResolvedValue(true);
        mongo.upsertOne = jest.fn().mockResolvedValue(true);

        result = await configuration.saveSymbolGridTrade(logger, 'BTCUSDT', {
          myKey: 'value'
        });
      });

      it('triggers mongo.upsertOne', () => {
        expect(mongo.upsertOne).toHaveBeenCalledWith(
          logger,
          'trailing-trade-grid-trade',
          { key: 'BTCUSDT' },
          { key: 'BTCUSDT', myKey: 'value' }
        );
      });

      it('triggers cache.hdel', () => {
        expect(cache.hdel).toHaveBeenCalledWith(
          'trailing-trade-configurations',
          'BTCUSDT'
        );
      });
    });
  });

  describe('calculateGridTradeProfit', () => {
    describe('when no data is provided', () => {
      beforeEach(async () => {
        result = configuration.calculateGridTradeProfit();
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({
          buyGridTradeExecuted: false,
          sellGridTradeExecuted: false,
          allExecuted: false,

          totalBuyQuoteQty: 0,
          totalSellQuoteQty: 0,

          buyGridTradeQuoteQty: 0,
          buyManualQuoteQty: 0,
          sellGridTradeQuoteQty: 0,
          sellManualQuoteQty: 0,
          stopLossQuoteQty: 0,

          profit: 0,
          profitPercentage: 0
        });
      });
    });

    describe('when buy/sell grid trades are provided', () => {
      beforeEach(async () => {
        result = configuration.calculateGridTradeProfit(
          [
            {
              executed: true,
              executedOrder: {
                cummulativeQuoteQty: '15.00'
              }
            },
            {
              executed: true,
              executedOrder: {
                cummulativeQuoteQty: '30.00'
              }
            }
          ],
          [
            {
              executed: true,
              executedOrder: {
                cummulativeQuoteQty: '20.00'
              }
            },
            {
              executed: true,
              executedOrder: {
                cummulativeQuoteQty: '40.00'
              }
            }
          ],
          {},
          []
        );
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({
          buyGridTradeExecuted: true,
          sellGridTradeExecuted: true,
          allExecuted: true,

          totalBuyQuoteQty: 45,
          totalSellQuoteQty: 60,

          buyGridTradeQuoteQty: 45,
          buyManualQuoteQty: 0,

          sellGridTradeQuoteQty: 60,
          sellManualQuoteQty: 0,
          stopLossQuoteQty: 0,

          profit: 15,
          profitPercentage: 33.33333333333333
        });
      });
    });

    describe('when manual trades are provided', () => {
      beforeEach(async () => {
        result = configuration.calculateGridTradeProfit([], [], {}, [
          {
            side: 'BUY',
            status: 'FILLED',
            cummulativeQuoteQty: '15.00'
          },
          {
            side: 'BUY',
            status: 'FILLED',
            cummulativeQuoteQty: '15.00'
          },
          {
            side: 'SELL',
            status: 'FILLED',
            cummulativeQuoteQty: '15.00'
          }
        ]);
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({
          buyGridTradeExecuted: false,
          sellGridTradeExecuted: false,
          allExecuted: false,

          totalBuyQuoteQty: 30,
          totalSellQuoteQty: 15,

          buyGridTradeQuoteQty: 0,
          buyManualQuoteQty: 30,
          sellGridTradeQuoteQty: 0,
          sellManualQuoteQty: 15,
          stopLossQuoteQty: 0,

          profit: -15,
          profitPercentage: -50
        });
      });
    });

    describe('when buy grid trades and stop loss are provided', () => {
      beforeEach(async () => {
        result = configuration.calculateGridTradeProfit(
          [
            {
              executed: true,
              executedOrder: {
                cummulativeQuoteQty: '15.00'
              }
            },
            {
              executed: true,
              executedOrder: {
                cummulativeQuoteQty: '30.00'
              }
            },
            {
              executed: false,
              executedOrder: null
            }
          ],
          [],
          {
            cummulativeQuoteQty: '30.00'
          },
          []
        );
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({
          buyGridTradeExecuted: true,
          sellGridTradeExecuted: false,
          allExecuted: false,

          totalBuyQuoteQty: 45,
          totalSellQuoteQty: 30,

          buyGridTradeQuoteQty: 45,
          buyManualQuoteQty: 0,

          sellGridTradeQuoteQty: 0,
          sellManualQuoteQty: 0,
          stopLossQuoteQty: 30,

          profit: -15,
          profitPercentage: -33.33333333333333
        });
      });
    });

    describe('for some reaosn, when all trades are provided', () => {
      beforeEach(async () => {
        result = configuration.calculateGridTradeProfit(
          [
            {
              executed: true,
              executedOrder: {
                cummulativeQuoteQty: '15.00'
              }
            },
            {
              executed: true,
              executedOrder: {
                cummulativeQuoteQty: '30.00'
              }
            }
          ],
          [
            {
              executed: true,
              executedOrder: {
                cummulativeQuoteQty: '20.00'
              }
            },
            {
              executed: true,
              executedOrder: {
                cummulativeQuoteQty: '40.00'
              }
            }
          ],
          {
            cummulativeQuoteQty: '30.00'
          },
          [
            {
              side: 'SELL',
              status: 'FILLED',
              cummulativeQuoteQty: '15.00'
            }
          ]
        );
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({
          buyGridTradeExecuted: true,
          sellGridTradeExecuted: true,
          allExecuted: true,

          totalBuyQuoteQty: 45,
          totalSellQuoteQty: 105,

          buyGridTradeQuoteQty: 45,
          buyManualQuoteQty: 0,
          sellGridTradeQuoteQty: 60,
          sellManualQuoteQty: 15,
          stopLossQuoteQty: 30,

          profit: 60,
          profitPercentage: 133.33333333333331
        });
      });
    });

    describe('when invalid trades', () => {
      beforeEach(async () => {
        result = configuration.calculateGridTradeProfit(
          [
            {
              executed: true,
              executedOrder: {}
            },
            {
              executed: false,
              executedOrder: {}
            }
          ],
          [
            {
              executed: true,
              executedOrder: {}
            },
            {
              executed: false,
              executedOrder: {}
            }
          ],
          {},
          [
            {
              side: 'BUY',
              status: 'FILLED'
            },
            {
              side: 'SELL',
              status: 'FILLED'
            }
          ]
        );
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({
          buyGridTradeExecuted: true,
          sellGridTradeExecuted: true,
          allExecuted: false,

          totalBuyQuoteQty: 0,
          totalSellQuoteQty: 0,

          buyGridTradeQuoteQty: 0,
          buyManualQuoteQty: 0,
          sellGridTradeQuoteQty: 0,
          sellManualQuoteQty: 0,
          stopLossQuoteQty: 0,

          profit: 0,
          profitPercentage: 0
        });
      });
    });
  });

  describe('saveSymbolGridTradeArchive', () => {
    describe('key is null', () => {
      beforeEach(async () => {
        cache.hdel = jest.fn().mockResolvedValue(true);
        mongo.upsertOne = jest.fn().mockResolvedValue(true);

        result = await configuration.saveSymbolGridTradeArchive(logger);
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({});
      });

      it('does not trigger mongo.upsertOne', () => {
        expect(mongo.upsertOne).not.toHaveBeenCalled();
      });

      it('does not trigger cache.hdel', () => {
        expect(cache.hdel).not.toHaveBeenCalled();
      });
    });

    describe('with valid data', () => {
      beforeEach(async () => {
        cache.hdel = jest.fn().mockResolvedValue(true);
        mongo.upsertOne = jest.fn().mockResolvedValue(true);

        result = await configuration.saveSymbolGridTradeArchive(
          logger,
          'BTCUSDT-2021-08-16T23:00:00+00:00',
          {
            symbol: 'BTCUSDT',
            some: 'value'
          }
        );
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual(true);
      });

      it('triggers mongo.upsertOne', () => {
        expect(mongo.upsertOne).toHaveBeenCalledWith(
          logger,
          'trailing-trade-grid-trade-archive',
          {
            key: 'BTCUSDT-2021-08-16T23:00:00+00:00'
          },
          {
            key: 'BTCUSDT-2021-08-16T23:00:00+00:00',
            symbol: 'BTCUSDT',
            some: 'value'
          }
        );
      });

      it('triggers cache.hdel', () => {
        expect(cache.hdel).toHaveBeenCalledWith(
          'trailing-trade-configurations',
          'BTCUSDT'
        );
      });
    });
  });

  describe('archiveSymbolGridTrade', () => {
    describe('when symbol  is not provided', () => {
      beforeEach(async () => {
        cache.hdel = jest.fn().mockResolvedValue(true);
        cache.hget = jest.fn().mockResolvedValue(
          JSON.stringify({
            symbol: 'BTCUSDT',
            baseAsset: 'BTC',
            quoteAsset: 'USDT'
          })
        );

        mongo.findOne = jest.fn().mockResolvedValue(null);

        result = await configuration.archiveSymbolGridTrade(logger);
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({});
      });

      it('does not trigger cache.hdel', () => {
        expect(cache.hdel).not.toHaveBeenCalled();
      });
    });

    describe('when symbol grid trade is not provided', () => {
      beforeEach(async () => {
        cache.hdel = jest.fn().mockResolvedValue(true);
        cache.hget = jest.fn().mockResolvedValue(
          JSON.stringify({
            symbol: 'BTCUSDT',
            baseAsset: 'BTC',
            quoteAsset: 'USDT'
          })
        );

        mongo.findOne = jest.fn().mockResolvedValue(null);

        result = await configuration.archiveSymbolGridTrade(logger, 'BTCUSDT');
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({});
      });

      it('does not trigger cache.hdel', () => {
        expect(cache.hdel).not.toHaveBeenCalled();
      });
    });

    describe('when symbol grid trade is provided', () => {
      beforeEach(async () => {
        cache.hdel = jest.fn().mockResolvedValue(true);
        cache.hget = jest.fn().mockResolvedValue(
          JSON.stringify({
            symbol: 'BTCUSDT',
            baseAsset: 'BTC',
            quoteAsset: 'USDT'
          })
        );

        mongo.findOne = jest.fn().mockResolvedValue({
          buy: [
            {
              executed: true,
              executedOrder: { cummulativeQuoteQty: '10.00' }
            },
            {
              executed: false
            }
          ],
          sell: [
            {
              executed: true,
              executedOrder: { cummulativeQuoteQty: '12.00' }
            },
            {
              executed: false
            }
          ],
          manualTrade: [
            {
              side: 'BUY',
              cummulativeQuoteQty: '12.00'
            },
            {
              side: 'SELL',
              cummulativeQuoteQty: '13.00'
            }
          ]
        });

        mongo.upsertOne = jest.fn().mockResolvedValue(true);

        result = await configuration.archiveSymbolGridTrade(logger, 'BTCUSDT');
      });

      it('triggers mongo.upsertOne', () => {
        expect(mongo.upsertOne).toHaveBeenCalledWith(
          logger,
          'trailing-trade-grid-trade-archive',
          { key: expect.stringContaining('BTCUSDT-') },
          {
            key: expect.stringContaining('BTCUSDT-'),
            symbol: 'BTCUSDT',
            baseAsset: 'BTC',
            quoteAsset: 'USDT',

            buyGridTradeExecuted: true,
            sellGridTradeExecuted: true,
            allExecuted: false,

            totalBuyQuoteQty: 22,
            totalSellQuoteQty: 25,

            buyGridTradeQuoteQty: 10,
            buyManualQuoteQty: 12,
            sellGridTradeQuoteQty: 12,
            sellManualQuoteQty: 13,
            stopLossQuoteQty: 0,

            profit: 3,
            profitPercentage: 13.636363636363635,

            buy: [
              {
                executed: true,
                executedOrder: { cummulativeQuoteQty: '10.00' }
              },
              {
                executed: false
              }
            ],
            sell: [
              {
                executed: true,
                executedOrder: { cummulativeQuoteQty: '12.00' }
              },
              {
                executed: false
              }
            ],
            manualTrade: [
              {
                side: 'BUY',
                cummulativeQuoteQty: '12.00'
              },
              {
                side: 'SELL',
                cummulativeQuoteQty: '13.00'
              }
            ],
            archivedAt: expect.any(String)
          }
        );
      });

      it('triggers cache.hdel', () => {
        expect(cache.hdel).toHaveBeenCalledWith(
          'trailing-trade-configurations',
          'BTCUSDT'
        );
      });
    });
  });

  describe('deleteAllSymbolConfiguration', () => {
    beforeEach(async () => {
      cache.hdelall = jest.fn().mockResolvedValue(true);
      mongo.deleteAll = jest.fn().mockResolvedValue(true);

      result = await configuration.deleteAllSymbolConfiguration(logger);
    });

    it('trigger mongo.deleteAll', () => {
      expect(mongo.deleteAll).toHaveBeenCalledWith(
        logger,
        'trailing-trade-symbols',
        {
          key: { $regex: /^(.+)-configuration/ }
        }
      );
    });

    it('triggers cache.hdelall', () => {
      expect(cache.hdelall).toHaveBeenCalledWith(
        'trailing-trade-configurations:*'
      );
    });
  });

  describe('deleteSymbolConfiguration', () => {
    beforeEach(async () => {
      cache.hdel = jest.fn().mockResolvedValue(true);
      mongo.deleteOne = jest.fn().mockResolvedValue(true);

      result = await configuration.deleteSymbolConfiguration(logger, 'BTCUSDT');
    });

    it('triggers mongo.deleteOne', () => {
      expect(mongo.deleteOne).toHaveBeenCalledWith(
        logger,
        'trailing-trade-symbols',
        {
          key: `BTCUSDT-configuration`
        }
      );
    });

    it('triggers cache.hdel', () => {
      expect(cache.hdel).toHaveBeenCalledWith(
        'trailing-trade-configurations',
        'BTCUSDT'
      );
    });
  });

  describe('deleteAllSymbolGridTrade', () => {
    beforeEach(async () => {
      cache.hdelall = jest.fn().mockResolvedValue(true);
      mongo.deleteAll = jest.fn().mockResolvedValue(true);

      result = await configuration.deleteAllSymbolGridTrade(logger);
    });

    it('triggers mongo.deleteAll', () => {
      expect(mongo.deleteAll).toHaveBeenCalledWith(
        logger,
        'trailing-trade-grid-trade',
        {}
      );
    });

    it('triggers cache.hdelall', () => {
      expect(cache.hdelall).toHaveBeenCalledWith(
        'trailing-trade-configurations:*'
      );
    });
  });

  describe('deleteSymbolGridTrade', () => {
    beforeEach(async () => {
      cache.hdel = jest.fn().mockResolvedValue(true);
      mongo.deleteOne = jest.fn().mockResolvedValue(true);

      result = await configuration.deleteSymbolGridTrade(logger, 'BTCUSDT');
    });

    it('triggers mongo.deleteOne', () => {
      expect(mongo.deleteOne).toHaveBeenCalledWith(
        logger,
        'trailing-trade-grid-trade',
        {
          key: 'BTCUSDT'
        }
      );
    });

    it('triggers cache.hdel', () => {
      expect(cache.hdel).toHaveBeenCalledWith(
        'trailing-trade-configurations',
        'BTCUSDT'
      );
    });
  });

  describe('getGridTradeBuy', () => {
    let cachedSymbolInfo;
    let globalConfiguration;
    let symbolConfiguration;

    describe('when grid trade is empty', () => {
      beforeEach(async () => {
        cachedSymbolInfo = {
          quoteAsset: 'USDT',
          filterMinNotional: { minNotional: 10 }
        };

        globalConfiguration = {
          buy: {
            gridTrade: [
              {
                minPurchaseAmounts: { USDT: 10 },
                maxPurchaseAmounts: { USDT: 15 }
              }
            ]
          }
        };

        symbolConfiguration = {
          buy: { gridTrade: [] }
        };

        result = configuration.getGridTradeBuy(
          logger,
          cachedSymbolInfo,
          globalConfiguration,
          symbolConfiguration
        );
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual([
          {
            minPurchaseAmount: 10,
            maxPurchaseAmount: 15
          }
        ]);
      });
    });

    describe('when min/max purchase amount is already defined', () => {
      beforeEach(async () => {
        cachedSymbolInfo = {
          quoteAsset: 'USDT',
          filterMinNotional: { minNotional: 10 }
        };

        globalConfiguration = {
          buy: {
            gridTrade: [
              {
                minPurchaseAmounts: { USDT: 10 },
                maxPurchaseAmounts: { USDT: 15 }
              },
              {
                minPurchaseAmounts: { USDT: 15 },
                maxPurchaseAmounts: { USDT: 20 }
              }
            ]
          }
        };

        symbolConfiguration = {
          buy: {
            gridTrade: [
              {
                minPurchaseAmount: 10,
                minPurchaseAmounts: { USDT: 10 },
                maxPurchaseAmount: 15,
                maxPurchaseAmounts: { USDT: 15 }
              }
            ]
          }
        };

        result = configuration.getGridTradeBuy(
          logger,
          cachedSymbolInfo,
          globalConfiguration,
          symbolConfiguration
        );
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual([
          {
            minPurchaseAmount: 10,
            maxPurchaseAmount: 15
          }
        ]);
      });
    });

    describe('when min/max purchase amount is not defined', () => {
      describe('when cached symbol info is not provided', () => {
        beforeEach(async () => {
          cachedSymbolInfo = {};

          globalConfiguration = {
            buy: {
              gridTrade: [
                { minPurchaseAmounts: {}, maxPurchaseAmounts: {} },
                { minPurchaseAmounts: {}, maxPurchaseAmounts: {} }
              ]
            }
          };

          symbolConfiguration = {
            buy: {
              gridTrade: [
                {
                  minPurchaseAmount: -1,
                  minPurchaseAmounts: {},
                  maxPurchaseAmount: -1,
                  maxPurchaseAmounts: {}
                }
              ]
            }
          };

          result = configuration.getGridTradeBuy(
            logger,
            cachedSymbolInfo,
            globalConfiguration,
            symbolConfiguration
          );
        });

        it('returns expected value', () => {
          expect(result).toStrictEqual([
            {
              minPurchaseAmount: -1,
              maxPurchaseAmount: -1
            }
          ]);
        });
      });

      describe('when cached symbol info is provided', () => {
        describe('when global configuration has max purchase amount defined', () => {
          beforeEach(async () => {
            cachedSymbolInfo = {
              quoteAsset: 'USDT',
              filterMinNotional: { minNotional: 10 }
            };

            globalConfiguration = {
              buy: {
                gridTrade: [
                  {
                    minPurchaseAmounts: { USDT: 10 },
                    maxPurchaseAmounts: { USDT: 12 }
                  },
                  {
                    minPurchaseAmounts: { USDT: 20 },
                    maxPurchaseAmounts: { USDT: 24 }
                  }
                ]
              }
            };

            symbolConfiguration = {
              buy: {
                gridTrade: [
                  {
                    minPurchaseAmount: -1,
                    maxPurchaseAmount: -1
                  }
                ]
              }
            };

            result = configuration.getGridTradeBuy(
              logger,
              cachedSymbolInfo,
              globalConfiguration,
              symbolConfiguration
            );
          });

          it('returns expected value', () => {
            expect(result).toStrictEqual([
              {
                minPurchaseAmount: 10,
                maxPurchaseAmount: 12
              }
            ]);
          });
        });

        describe('when global configuration does not have max purchase amount', () => {
          beforeEach(async () => {
            cachedSymbolInfo = {
              quoteAsset: 'USDT',
              filterMinNotional: { minNotional: 10 }
            };

            globalConfiguration = {
              buy: {
                gridTrade: [
                  { minPurchaseAmounts: {}, maxPurchaseAmounts: {} },
                  { minPurchaseAmounts: {}, maxPurchaseAmounts: {} },
                  { minPurchaseAmounts: {}, maxPurchaseAmounts: {} }
                ]
              }
            };

            symbolConfiguration = {
              buy: {
                gridTrade: [
                  {
                    minPurchaseAmount: -1,
                    minPurchaseAmounts: {},
                    maxPurchaseAmount: -1,
                    maxPurchaseAmounts: {}
                  }
                ]
              }
            };

            result = configuration.getGridTradeBuy(
              logger,
              cachedSymbolInfo,
              globalConfiguration,
              symbolConfiguration
            );
          });

          it('returns expected value', () => {
            expect(result).toStrictEqual([
              {
                minPurchaseAmount: 10,
                maxPurchaseAmount: 100
              }
            ]);
          });
        });
      });
    });
  });

  describe('getGridTradeSell', () => {
    let cachedSymbolInfo;
    let globalConfiguration;
    let symbolConfiguration;

    describe('when grid trade is empty', () => {
      beforeEach(() => {
        cachedSymbolInfo = {
          quoteAsset: 'USDT'
        };

        globalConfiguration = {
          sell: {
            gridTrade: [
              {
                quantityPercentages: {
                  USDT: 0.5
                }
              },
              {
                quantityPercentages: {
                  USDT: 1
                }
              }
            ]
          }
        };

        symbolConfiguration = {
          sell: {
            gridTrade: []
          }
        };

        result = configuration.getGridTradeSell(
          logger,
          cachedSymbolInfo,
          globalConfiguration,
          symbolConfiguration
        );
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual([
          {
            quantityPercentage: 0.5
          },
          {
            quantityPercentage: 1
          }
        ]);
      });
    });

    describe('when quantity percentage is already defined', () => {
      beforeEach(() => {
        cachedSymbolInfo = {
          quoteAsset: 'USDT'
        };

        globalConfiguration = {
          sell: {
            gridTrade: [
              {
                quantityPercentages: {
                  USDT: 0.5
                }
              },
              {
                quantityPercentages: {
                  USDT: 1
                }
              },
              {
                quantityPercentages: {
                  USDT: 1
                }
              }
            ]
          }
        };

        symbolConfiguration = {
          sell: {
            gridTrade: [
              {
                quantityPercentage: 0.8,
                quantityPercentages: {
                  USDT: 0.5
                }
              },
              {
                quantityPercentage: 1,
                quantityPercentages: {
                  USDT: 1
                }
              }
            ]
          }
        };

        result = configuration.getGridTradeSell(
          logger,
          cachedSymbolInfo,
          globalConfiguration,
          symbolConfiguration
        );
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual([
          {
            quantityPercentage: 0.8
          },
          {
            quantityPercentage: 1
          }
        ]);
      });
    });

    describe('when quantity percentage is not defined', () => {
      describe('when cached symbol info is not provided', () => {
        beforeEach(() => {
          cachedSymbolInfo = {};

          globalConfiguration = {
            sell: {
              gridTrade: [
                {
                  quantityPercentages: {
                    USDT: 0.5
                  }
                }
              ]
            }
          };

          symbolConfiguration = {
            sell: {
              gridTrade: [
                {
                  quantityPercentage: -1,
                  quantityPercentages: {
                    USDT: 0.5
                  }
                },
                {
                  quantityPercentage: -1,
                  quantityPercentages: {
                    USDT: 1
                  }
                }
              ]
            }
          };

          result = configuration.getGridTradeSell(
            logger,
            cachedSymbolInfo,
            globalConfiguration,
            symbolConfiguration
          );
        });

        it('returns expected result', () => {
          expect(result).toStrictEqual([
            {
              quantityPercentage: -1
            },
            {
              quantityPercentage: -1
            }
          ]);
        });
      });

      describe('when cached symbol info is provided', () => {
        describe('when global configuration has quantity percentage defined', () => {
          beforeEach(() => {
            cachedSymbolInfo = {
              quoteAsset: 'USDT'
            };
            globalConfiguration = {
              sell: {
                gridTrade: [
                  {
                    quantityPercentages: {
                      USDT: 0.5
                    }
                  }
                ]
              }
            };

            symbolConfiguration = {
              sell: {
                gridTrade: [
                  {
                    quantityPercentage: -1,
                    quantityPercentages: {
                      USDT: 0.5
                    }
                  },
                  {
                    quantityPercentage: -1,
                    quantityPercentages: {
                      USDT: 1
                    }
                  }
                ]
              }
            };

            result = configuration.getGridTradeSell(
              logger,
              cachedSymbolInfo,
              globalConfiguration,
              symbolConfiguration
            );
          });

          it('returns expected result', () => {
            expect(result).toStrictEqual([
              {
                quantityPercentage: 0.5
              },
              {
                quantityPercentage: 1
              }
            ]);
          });
        });

        describe('when global configuration does not thave quantity percentage', () => {
          describe('when there was only one grid trade', () => {
            beforeEach(() => {
              cachedSymbolInfo = {
                quoteAsset: 'USDT'
              };

              globalConfiguration = {
                sell: {
                  gridTrade: [
                    {
                      quantityPercentages: {}
                    }
                  ]
                }
              };

              symbolConfiguration = {
                sell: {
                  gridTrade: [
                    {
                      quantityPercentage: -1,
                      quantityPercentages: {}
                    },
                    {
                      quantityPercentage: -1,
                      quantityPercentages: {}
                    }
                  ]
                }
              };

              result = configuration.getGridTradeSell(
                logger,
                cachedSymbolInfo,
                globalConfiguration,
                symbolConfiguration
              );
            });

            it('returns expected result', () => {
              expect(result).toStrictEqual([
                {
                  quantityPercentage: 0.5
                },
                {
                  quantityPercentage: 1
                }
              ]);
            });
          });

          describe('when there are 3 grid trades', () => {
            beforeEach(() => {
              cachedSymbolInfo = {
                quoteAsset: 'USDT'
              };

              globalConfiguration = {
                sell: {
                  gridTrade: [
                    {
                      quantityPercentages: {}
                    },
                    {
                      quantityPercentages: {}
                    }
                  ]
                }
              };

              symbolConfiguration = {
                sell: {
                  gridTrade: [
                    {
                      quantityPercentage: -1,
                      quantityPercentages: {}
                    },
                    {
                      quantityPercentage: -1,
                      quantityPercentages: {}
                    },
                    {
                      quantityPercentage: -1,
                      quantityPercentages: {}
                    }
                  ]
                }
              };

              result = configuration.getGridTradeSell(
                logger,
                cachedSymbolInfo,
                globalConfiguration,
                symbolConfiguration
              );
            });

            it('returns expected result', () => {
              expect(result).toStrictEqual([
                {
                  quantityPercentage: 0.33
                },
                {
                  quantityPercentage: 0.33
                },
                {
                  quantityPercentage: 1
                }
              ]);
            });
          });
        });
      });
    });
  });

  describe('getLastBuyPriceRemoveThreshold', () => {
    let cachedSymbolInfo;
    let globalConfiguration;
    let symbolConfiguration;

    describe('when last buy price remove threshold is already defined', () => {
      beforeEach(() => {
        cachedSymbolInfo = {
          quoteAsset: 'USDT',
          filterMinNotional: { minNotional: 10 }
        };

        globalConfiguration = {
          buy: {
            lastBuyPriceRemoveThresholds: {
              USDT: 5
            }
          }
        };

        symbolConfiguration = {
          buy: {
            lastBuyPriceRemoveThreshold: 7
          }
        };

        result = configuration.getLastBuyPriceRemoveThreshold(
          logger,
          cachedSymbolInfo,
          globalConfiguration,
          symbolConfiguration
        );
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual(7);
      });
    });

    describe('when last buy price remove threshold is not defined', () => {
      describe('when symbol info is not provided', () => {
        beforeEach(() => {
          cachedSymbolInfo = {};

          globalConfiguration = {
            buy: {
              lastBuyPriceRemoveThresholds: {
                USDT: 5
              }
            }
          };

          symbolConfiguration = {
            buy: {
              lastBuyPriceRemoveThreshold: -1
            }
          };

          result = configuration.getLastBuyPriceRemoveThreshold(
            logger,
            cachedSymbolInfo,
            globalConfiguration,
            symbolConfiguration
          );
        });

        it('returns expected value', () => {
          expect(result).toStrictEqual(-1);
        });
      });

      describe('when symbol info is provided', () => {
        describe('when global configuration has last buy price remove threshold', () => {
          beforeEach(() => {
            cachedSymbolInfo = {
              quoteAsset: 'USDT',
              filterMinNotional: { minNotional: 10 }
            };

            globalConfiguration = {
              buy: {
                lastBuyPriceRemoveThresholds: {
                  USDT: 5
                }
              }
            };

            symbolConfiguration = {
              buy: {
                lastBuyPriceRemoveThreshold: -1
              }
            };

            result = configuration.getLastBuyPriceRemoveThreshold(
              logger,
              cachedSymbolInfo,
              globalConfiguration,
              symbolConfiguration
            );
          });

          it('returns expected value', () => {
            expect(result).toStrictEqual(5);
          });
        });

        describe('when global configuration does not have last buy price remove threshold', () => {
          beforeEach(() => {
            cachedSymbolInfo = {
              quoteAsset: 'USDT',
              filterMinNotional: { minNotional: 10 }
            };

            globalConfiguration = {
              buy: {
                lastBuyPriceRemoveThresholds: {}
              }
            };

            symbolConfiguration = {
              buy: {
                lastBuyPriceRemoveThreshold: -1
              }
            };

            result = configuration.getLastBuyPriceRemoveThreshold(
              logger,
              cachedSymbolInfo,
              globalConfiguration,
              symbolConfiguration
            );
          });

          it('returns expected value', () => {
            expect(result).toStrictEqual(10);
          });
        });
      });
    });
  });

  describe('postProcessConfiguration', () => {
    let configurationParam;
    let symbolGridTrade;
    const symbol = 'BTCUSDT';

    describe('when symbol grid trades contain executed orders', () => {
      describe('when first grid order is executed', () => {
        beforeEach(async () => {
          mongo.findOne = jest.fn().mockResolvedValue({
            lastBuyPrice: 3000,
            quantity: 0.1
          });

          configurationParam = {
            buy: {
              gridTrade: [
                {
                  triggerPercentage: 1
                },
                {
                  triggerPercentage: 0.9
                },
                {
                  triggerPercentage: 0.8
                }
              ]
            },
            sell: {
              gridTrade: [
                {
                  triggerPercentage: 1.02
                },
                {
                  triggerPercentage: 1.03
                },
                {
                  triggerPercentage: 1.04
                }
              ]
            }
          };

          symbolGridTrade = {
            buy: [
              {
                triggerPercentage: 1.01,
                executed: true,
                executedOrder: { orderId: 1 }
              },
              {
                triggerPercentage: 0.95,
                executed: false,
                executedOrder: null
              },
              {
                triggerPercentage: 0.9,
                executed: false,
                executedOrder: null
              }
            ],
            sell: [
              {
                triggerPercentage: 1.05,
                executed: true,
                executedOrder: { orderId: 1 }
              },
              {
                triggerPercentage: 1.06,
                executed: false,
                executedOrder: null
              },
              {
                triggerPercentage: 1.07,
                executed: false,
                executedOrder: null
              }
            ]
          };

          result = await configuration.postProcessConfiguration(
            logger,
            configurationParam,
            { symbolGridTrade, symbol }
          );
        });

        it('returns expected value', () => {
          expect(result).toStrictEqual({
            buy: {
              currentGridTrade: {
                executed: false,
                executedOrder: null,
                triggerPercentage: 0.9
              },
              currentGridTradeIndex: 1,
              gridTrade: [
                {
                  executed: true,
                  executedOrder: { orderId: 1 },
                  triggerPercentage: 1.01
                },
                {
                  executed: false,
                  executedOrder: null,
                  triggerPercentage: 0.9
                },
                {
                  executed: false,
                  executedOrder: null,
                  triggerPercentage: 0.8
                }
              ]
            },
            sell: {
              currentGridTrade: {
                executed: false,
                executedOrder: null,
                triggerPercentage: 1.03
              },
              currentGridTradeIndex: 1,
              gridTrade: [
                {
                  executed: true,
                  executedOrder: { orderId: 1 },
                  triggerPercentage: 1.05
                },
                {
                  executed: false,
                  executedOrder: null,
                  triggerPercentage: 1.03
                },
                {
                  executed: false,
                  executedOrder: null,
                  triggerPercentage: 1.04
                }
              ]
            }
          });
        });
      });

      describe('when second grid order is executed', () => {
        beforeEach(async () => {
          mongo.findOne = jest.fn().mockResolvedValue({
            lastBuyPrice: 3000,
            quantity: 0.1
          });

          configurationParam = {
            buy: {
              gridTrade: [
                {
                  triggerPercentage: 1.02
                },
                {
                  triggerPercentage: 0.95
                },
                {
                  triggerPercentage: 0.85
                }
              ]
            },
            sell: {
              gridTrade: [
                {
                  triggerPercentage: 1.051
                },
                {
                  triggerPercentage: 1.062
                },
                {
                  triggerPercentage: 1.073
                }
              ]
            }
          };

          symbolGridTrade = {
            buy: [
              {
                triggerPercentage: 1,
                executed: false,
                executedOrder: null
              },
              {
                triggerPercentage: 0.9,
                executed: true,
                executedOrder: { orderId: 1 }
              },
              {
                triggerPercentage: 0.8,
                executed: false,
                executedOrder: null
              }
            ],
            sell: [
              {
                triggerPercentage: 1.03,
                executed: false,
                executedOrder: null
              },
              {
                triggerPercentage: 1.04,
                executed: true,
                executedOrder: { orderId: 2 }
              },
              {
                triggerPercentage: 1.05,
                executed: false,
                executedOrder: null
              }
            ]
          };

          result = await configuration.postProcessConfiguration(
            logger,
            configurationParam,
            { symbolGridTrade, symbol }
          );
        });

        it('returns expected value', () => {
          expect(result).toStrictEqual({
            buy: {
              currentGridTrade: {
                executed: false,
                executedOrder: null,
                triggerPercentage: 0.85
              },
              currentGridTradeIndex: 2,
              gridTrade: [
                {
                  executed: false,
                  executedOrder: null,
                  triggerPercentage: 1.02
                },
                {
                  executed: true,
                  executedOrder: { orderId: 1 },
                  triggerPercentage: 0.9
                },
                {
                  executed: false,
                  executedOrder: null,
                  triggerPercentage: 0.85
                }
              ]
            },
            sell: {
              currentGridTrade: {
                executed: false,
                executedOrder: null,
                triggerPercentage: 1.073
              },
              currentGridTradeIndex: 2,
              gridTrade: [
                {
                  executed: false,
                  executedOrder: null,
                  triggerPercentage: 1.051
                },
                {
                  executed: true,
                  executedOrder: { orderId: 2 },
                  triggerPercentage: 1.04
                },
                {
                  executed: false,
                  executedOrder: null,
                  triggerPercentage: 1.073
                }
              ]
            }
          });
        });
      });

      describe('when second/last grid orders are executed', () => {
        beforeEach(async () => {
          mongo.findOne = jest.fn().mockResolvedValue({
            lastBuyPrice: 3000,
            quantity: 0.1
          });

          configurationParam = {
            buy: {
              gridTrade: [
                {
                  triggerPercentage: 1.03
                },
                {
                  triggerPercentage: 0.8
                },
                {
                  triggerPercentage: 0.7
                }
              ]
            },
            sell: {
              gridTrade: [
                {
                  triggerPercentage: 1.055
                },
                {
                  triggerPercentage: 1.066
                },
                {
                  triggerPercentage: 1.077
                }
              ]
            }
          };

          symbolGridTrade = {
            buy: [
              {
                triggerPercentage: 1,
                executed: false,
                executedOrder: null
              },
              {
                triggerPercentage: 0.9,
                executed: true,
                executedOrder: { orderId: 1 }
              },
              {
                triggerPercentage: 0.8,
                executed: true,
                executedOrder: { orderId: 2 }
              }
            ],
            sell: [
              {
                triggerPercentage: 1.03,
                executed: false,
                executedOrder: null
              },
              {
                triggerPercentage: 1.04,
                executed: true,
                executedOrder: { orderId: 2 }
              },
              {
                triggerPercentage: 1.05,
                executed: true,
                executedOrder: { orderId: 3 }
              }
            ]
          };

          result = await configuration.postProcessConfiguration(
            logger,
            configurationParam,
            { symbolGridTrade, symbol }
          );
        });

        it('returns expected value', () => {
          expect(result).toStrictEqual({
            buy: {
              currentGridTrade: null,
              currentGridTradeIndex: -1,
              gridTrade: [
                {
                  executed: false,
                  executedOrder: null,
                  triggerPercentage: 1.03
                },
                {
                  executed: true,
                  executedOrder: { orderId: 1 },
                  triggerPercentage: 0.9
                },
                {
                  executed: true,
                  executedOrder: { orderId: 2 },
                  triggerPercentage: 0.8
                }
              ]
            },
            sell: {
              currentGridTrade: null,
              currentGridTradeIndex: -1,
              gridTrade: [
                {
                  executed: false,
                  executedOrder: null,
                  triggerPercentage: 1.055
                },
                {
                  executed: true,
                  executedOrder: { orderId: 2 },
                  triggerPercentage: 1.04
                },
                {
                  executed: true,
                  executedOrder: { orderId: 3 },
                  triggerPercentage: 1.05
                }
              ]
            }
          });
        });
      });

      describe('when all grid orders are executed', () => {
        beforeEach(async () => {
          mongo.findOne = jest.fn().mockResolvedValue({
            lastBuyPrice: 3000,
            quantity: 0.1
          });

          configurationParam = {
            buy: {
              gridTrade: [
                {
                  triggerPercentage: 1.03
                },
                {
                  triggerPercentage: 0.8
                },
                {
                  triggerPercentage: 0.7
                }
              ]
            },
            sell: {
              gridTrade: [
                {
                  triggerPercentage: 1.055
                },
                {
                  triggerPercentage: 1.066
                },
                {
                  triggerPercentage: 1.077
                }
              ]
            }
          };

          symbolGridTrade = {
            buy: [
              {
                triggerPercentage: 1,
                executed: true,
                executedOrder: { orderId: 4 }
              },
              {
                triggerPercentage: 0.9,
                executed: true,
                executedOrder: { orderId: 1 }
              },
              {
                triggerPercentage: 0.8,
                executed: true,
                executedOrder: { orderId: 2 }
              }
            ],
            sell: [
              {
                triggerPercentage: 1.03,
                executed: true,
                executedOrder: { orderId: 4 }
              },
              {
                triggerPercentage: 1.04,
                executed: true,
                executedOrder: { orderId: 2 }
              },
              {
                triggerPercentage: 1.05,
                executed: true,
                executedOrder: { orderId: 3 }
              }
            ]
          };

          result = await configuration.postProcessConfiguration(
            logger,
            configurationParam,
            { symbolGridTrade, symbol }
          );
        });

        it('returns expected value', () => {
          expect(result).toStrictEqual({
            buy: {
              currentGridTrade: null,
              currentGridTradeIndex: -1,
              gridTrade: [
                {
                  executed: true,
                  executedOrder: { orderId: 4 },
                  triggerPercentage: 1
                },
                {
                  executed: true,
                  executedOrder: { orderId: 1 },
                  triggerPercentage: 0.9
                },
                {
                  executed: true,
                  executedOrder: { orderId: 2 },
                  triggerPercentage: 0.8
                }
              ]
            },
            sell: {
              currentGridTrade: null,
              currentGridTradeIndex: -1,
              gridTrade: [
                {
                  executed: true,
                  executedOrder: { orderId: 4 },
                  triggerPercentage: 1.03
                },
                {
                  executed: true,
                  executedOrder: { orderId: 2 },
                  triggerPercentage: 1.04
                },
                {
                  executed: true,
                  executedOrder: { orderId: 3 },
                  triggerPercentage: 1.05
                }
              ]
            }
          });
        });
      });
    });

    describe('when grid trades have no executed orders', () => {
      describe('when side is buy, has last buy price, and 2nd grid trade is defined', () => {
        beforeEach(async () => {
          mongo.findOne = jest.fn().mockResolvedValue({
            lastBuyPrice: 3000,
            quantity: 0.1
          });

          configurationParam = {
            buy: {
              gridTrade: [
                {
                  triggerPercentage: 1
                },
                {
                  triggerPercentage: 0.9
                },
                {
                  triggerPercentage: 0.8
                }
              ]
            },
            sell: {
              gridTrade: [
                {
                  triggerPercentage: 1.02
                },
                {
                  triggerPercentage: 1.03
                },
                {
                  triggerPercentage: 1.04
                }
              ]
            }
          };

          symbolGridTrade = {
            buy: [
              {
                triggerPercentage: 1,
                executed: false
              },
              {
                triggerPercentage: 0.9,
                executed: false
              },
              {
                triggerPercentage: 0.8,
                executed: false
              }
            ],
            sell: [
              {
                triggerPercentage: 1.03,
                executed: false
              },
              {
                triggerPercentage: 1.04,
                executed: false
              },
              {
                triggerPercentage: 1.05,
                executed: false
              }
            ]
          };

          result = await configuration.postProcessConfiguration(
            logger,
            configurationParam,
            { symbolGridTrade, symbol }
          );
        });

        it('returns expected value', () => {
          expect(result).toStrictEqual({
            buy: {
              currentGridTrade: {
                executed: false,
                executedOrder: null,
                triggerPercentage: 0.9
              },
              currentGridTradeIndex: 1,
              gridTrade: [
                {
                  executed: false,
                  executedOrder: null,
                  triggerPercentage: 1
                },
                {
                  executed: false,
                  executedOrder: null,
                  triggerPercentage: 0.9
                },
                {
                  executed: false,
                  executedOrder: null,
                  triggerPercentage: 0.8
                }
              ]
            },
            sell: {
              currentGridTrade: {
                executed: false,
                executedOrder: null,
                triggerPercentage: 1.02
              },
              currentGridTradeIndex: 0,
              gridTrade: [
                {
                  executed: false,
                  executedOrder: null,
                  triggerPercentage: 1.02
                },
                {
                  executed: false,
                  executedOrder: null,
                  triggerPercentage: 1.03
                },
                {
                  executed: false,
                  executedOrder: null,
                  triggerPercentage: 1.04
                }
              ]
            }
          });
        });
      });

      describe('when side is buy, has last buy price, but 2nd grid trade is not defined', () => {
        beforeEach(async () => {
          mongo.findOne = jest.fn().mockResolvedValue({
            lastBuyPrice: 3000,
            quantity: 0.1
          });

          configurationParam = {
            buy: {
              gridTrade: [
                {
                  triggerPercentage: 1
                }
              ]
            },
            sell: {
              gridTrade: [
                {
                  triggerPercentage: 1.02
                }
              ]
            }
          };

          symbolGridTrade = {
            buy: [
              {
                triggerPercentage: 1,
                executed: false
              }
            ],
            sell: [
              {
                triggerPercentage: 1.03,
                executed: false
              }
            ]
          };

          result = await configuration.postProcessConfiguration(
            logger,
            configurationParam,
            { symbolGridTrade, symbol }
          );
        });

        it('returns expected value', () => {
          expect(result).toStrictEqual({
            buy: {
              currentGridTrade: null,
              currentGridTradeIndex: -1,
              gridTrade: [
                {
                  executed: false,
                  executedOrder: null,
                  triggerPercentage: 1
                }
              ]
            },
            sell: {
              currentGridTrade: {
                executed: false,
                executedOrder: null,
                triggerPercentage: 1.02
              },
              currentGridTradeIndex: 0,
              gridTrade: [
                {
                  executed: false,
                  executedOrder: null,
                  triggerPercentage: 1.02
                }
              ]
            }
          });
        });
      });

      describe('when none of conditions are matching', () => {
        beforeEach(async () => {
          mongo.findOne = jest.fn().mockResolvedValue(null);

          configurationParam = {
            buy: {
              gridTrade: [
                {
                  triggerPercentage: 1
                },
                {
                  triggerPercentage: 0.9
                },
                {
                  triggerPercentage: 0.8
                }
              ]
            },
            sell: {
              gridTrade: [
                {
                  triggerPercentage: 1.02
                },
                {
                  triggerPercentage: 1.03
                },
                {
                  triggerPercentage: 1.04
                }
              ]
            }
          };

          symbolGridTrade = {
            buy: [
              {
                triggerPercentage: 1,
                executed: false
              },
              {
                triggerPercentage: 0.9,
                executed: false
              },
              {
                triggerPercentage: 0.8,
                executed: false
              }
            ],
            sell: [
              {
                triggerPercentage: 1.03,
                executed: false
              },
              {
                triggerPercentage: 1.04,
                executed: false
              },
              {
                triggerPercentage: 1.05,
                executed: false
              }
            ]
          };

          result = await configuration.postProcessConfiguration(
            logger,
            configurationParam,
            { symbolGridTrade, symbol }
          );
        });

        it('returns expected value', () => {
          expect(result).toStrictEqual({
            buy: {
              currentGridTrade: {
                executed: false,
                executedOrder: null,
                triggerPercentage: 1
              },
              currentGridTradeIndex: 0,
              gridTrade: [
                {
                  executed: false,
                  executedOrder: null,
                  triggerPercentage: 1
                },
                {
                  executed: false,
                  executedOrder: null,
                  triggerPercentage: 0.9
                },
                {
                  executed: false,
                  executedOrder: null,
                  triggerPercentage: 0.8
                }
              ]
            },
            sell: {
              currentGridTrade: {
                executed: false,
                executedOrder: null,
                triggerPercentage: 1.02
              },
              currentGridTradeIndex: 0,
              gridTrade: [
                {
                  executed: false,
                  executedOrder: null,
                  triggerPercentage: 1.02
                },
                {
                  executed: false,
                  executedOrder: null,
                  triggerPercentage: 1.03
                },
                {
                  executed: false,
                  executedOrder: null,
                  triggerPercentage: 1.04
                }
              ]
            }
          });
        });
      });
    });
  });

  describe('getConfiguration', () => {
    beforeEach(() => {
      mongo.upsertOne = jest.fn().mockResolvedValue(true);
      mongo.dropIndex = jest.fn().mockResolvedValue(true);
      mongo.createIndex = jest.fn().mockResolvedValue(true);

      cache.del = jest.fn().mockResolvedValue(true);
      cache.hdelall = jest.fn().mockResolvedValue(true);
      cache.hget = jest.fn().mockImplementation((hash, _key) => {
        if (hash === 'trailing-trade-symbols') {
          return Promise.resolve(
            JSON.stringify({
              quoteAsset: 'USDT',
              filterMinNotional: {
                minNotional: '10.00000000'
              }
            })
          );
        }

        return Promise.resolve(null);
      });
      cache.hset = jest.fn().mockResolvedValue(true);

      config.get = jest.fn(key => {
        if (key === 'jobs.trailingTrade') {
          return {
            enabled: true,
            cronTime: '* * * * * *',
            symbols: ['BTCUSDT', 'ETHUSDT', 'ETHBTC', 'XRPBTC'],
            candles: {
              interval: '1h',
              limit: 100
            },
            botOptions: {
              logs: {
                deleteAfter: 30
              }
            },
            buy: {
              enabled: true,
              gridTrade: [
                {
                  triggerPercentage: 1,
                  stopPercentage: 1.02,
                  limitPercentage: 1.021,
                  minPurchaseAmount: -1,
                  minPurchaseAmounts: {},
                  maxPurchaseAmount: -1,
                  maxPurchaseAmounts: {}
                }
              ],
              lastBuyPriceRemoveThreshold: -1,
              lastBuyPriceRemoveThresholds: {
                USDT: 10
              },
              athRestriction: {
                enabled: true,
                candles: {
                  interval: '1d',
                  limit: 30
                },
                restrictionPercentage: 0.9
              }
            },
            sell: {
              enabled: true,
              gridTrade: [
                {
                  triggerPercentage: 1.06,
                  stopPercentage: 0.98,
                  limitPercentage: 0.979,
                  quantityPercentage: -1,
                  quantityPercentages: {}
                }
              ],
              stopLoss: {
                enabled: false,
                maxLossPercentage: 0.8,
                disableBuyMinutes: 360,
                orderType: 'market'
              }
            },
            system: {
              temporaryDisableActionAfterConfirmingOrder: 20,
              checkManualBuyOrderPeriod: 5,
              placeManualOrderInterval: 5,
              refreshAccountInfoPeriod: 1,
              checkOrderExecutePeriod: 10
            }
          };
        }
        return null;
      });
    });

    describe('without symbol', () => {
      describe('when cache is available', () => {
        beforeEach(async () => {
          cache.hget = jest.fn().mockImplementation((hash, key) => {
            if (hash === 'trailing-trade-configurations' && key === 'global') {
              return Promise.resolve(
                JSON.stringify({
                  global: 'configuration'
                })
              );
            }

            return Promise.resolve(null);
          });

          result = await configuration.getConfiguration(logger);
        });

        it('returns cached configruation', () => {
          expect(result).toStrictEqual({
            global: 'configuration'
          });
        });
      });

      describe('when cache is not available', () => {
        beforeEach(async () => {
          mongo.findOne = jest.fn((_logger, collection, filter) => {
            if (
              collection === 'trailing-trade-common' &&
              _.isEqual(filter, { key: 'configuration' })
            ) {
              return {
                enabled: true,
                cronTime: '* * * * * *',
                symbols: ['BNBUSDT', 'TRXBUSD', 'LTCUSDT', 'XRPBTC'],
                candles: {
                  interval: '1d',
                  limit: 10
                },
                buy: {
                  enabled: false,
                  gridTrade: [
                    {
                      triggerPercentage: 1,
                      stopPercentage: 1.02,
                      limitPercentage: 1.021,
                      minPurchaseAmount: -1,
                      minPurchaseAmounts: {
                        USDT: 15,
                        BTC: 0.002,
                        BUSD: 30
                      },
                      maxPurchaseAmount: -1,
                      maxPurchaseAmounts: {
                        USDT: 100,
                        BTC: 0.005,
                        BUSD: 100
                      }
                    },
                    {
                      triggerPercentage: 0.9,
                      stopPercentage: 1.02,
                      limitPercentage: 1.021,
                      minPurchaseAmount: -1,
                      minPurchaseAmounts: {
                        USDT: 100,
                        BTC: 0.001,
                        BUSD: 100
                      },
                      maxPurchaseAmount: -1,
                      maxPurchaseAmounts: {
                        USDT: 100,
                        BTC: 0.001,
                        BUSD: 100
                      }
                    }
                  ],
                  lastBuyPriceRemoveThreshold: -1,
                  lastBuyPriceRemoveThresholds: {
                    USDT: 5,
                    BTC: 0.00005,
                    BUSD: 5
                  },
                  athRestriction: {
                    enabled: true,
                    candles: {
                      interval: '1d',
                      limit: 30
                    },
                    restrictionPercentage: 0.9
                  }
                },
                sell: {
                  enabled: false,
                  gridTrade: [
                    {
                      triggerPercentage: 1.08,
                      stopPercentage: 0.95,
                      limitPercentage: 0.949,
                      quantityPercentage: -1,
                      quantityPercentages: {
                        USDT: 1,
                        BTC: 1,
                        BUSD: 1
                      }
                    }
                  ],
                  stopLoss: {
                    enabled: true,
                    maxLossPercentage: 0.95,
                    disableBuyMinutes: 60,
                    orderType: 'market'
                  }
                },
                botOptions: {
                  logs: {
                    deleteAfter: 30
                  }
                },
                system: {
                  temporaryDisableActionAfterConfirmingOrder: 10,
                  checkManualBuyOrderPeriod: 10,
                  placeManualOrderInterval: 5,
                  refreshAccountInfoPeriod: 3,
                  checkOrderExecutePeriod: 10
                }
              };
            }
            if (
              collection === 'trailing-trade-symbols' &&
              _.isEqual(filter, { key: 'BTCUSDT-configuration' })
            ) {
              return {
                key: 'BTCUSDT-configuration',
                candles: {
                  interval: '1h',
                  limit: 50
                },
                buy: {
                  enabled: true,
                  gridTrade: [
                    {
                      triggerPercentage: 1,
                      stopPercentage: 1.025,
                      limitPercentage: 1.026,
                      minPurchaseAmount: 10,
                      maxPurchaseAmount: 10
                    },
                    {
                      triggerPercentage: 0.9,
                      stopPercentage: 1.025,
                      limitPercentage: 1.026,
                      minPurchaseAmount: 15,
                      maxPurchaseAmount: 20
                    },
                    {
                      triggerPercentage: 0.9,
                      stopPercentage: 1.025,
                      limitPercentage: 1.056,
                      minPurchaseAmount: 30,
                      maxPurchaseAmount: 30
                    }
                  ],
                  lastBuyPriceRemoveThreshold: 4
                },
                sell: {
                  enabled: true,
                  gridTrade: [
                    {
                      triggerPercentage: 1.025,
                      stopPercentage: 0.985,
                      limitPercentage: 0.984,
                      quantityPercentage: 1,
                      quantityPercentages: {
                        USDT: 1
                      }
                    }
                  ],
                  stopLoss: {
                    enabled: true,
                    maxLossPercentage: 0.81,
                    disableBuyMinutes: 65,
                    orderType: 'market'
                  }
                }
              };
            }
            return null;
          });

          result = await configuration.getConfiguration(logger);
        });

        it('triggers config.get', () => {
          expect(config.get).toHaveBeenCalled();
        });

        it('does not trigger mongo.upsertOne', () => {
          expect(mongo.upsertOne).not.toHaveBeenCalled();
        });

        it('triggers cache.hset', () => {
          expect(cache.hset).toHaveBeenCalledWith(
            'trailing-trade-configurations',
            'global',
            JSON.stringify({
              enabled: true,
              cronTime: '* * * * * *',
              symbols: ['BNBUSDT', 'TRXBUSD', 'LTCUSDT', 'XRPBTC'],
              candles: { interval: '1d', limit: 10 },
              buy: {
                enabled: false,
                gridTrade: [
                  {
                    triggerPercentage: 1,
                    stopPercentage: 1.02,
                    limitPercentage: 1.021,
                    minPurchaseAmount: -1,
                    minPurchaseAmounts: { USDT: 15, BTC: 0.002, BUSD: 30 },
                    maxPurchaseAmount: -1,
                    maxPurchaseAmounts: { USDT: 100, BTC: 0.005, BUSD: 100 }
                  },
                  {
                    triggerPercentage: 0.9,
                    stopPercentage: 1.02,
                    limitPercentage: 1.021,
                    minPurchaseAmount: -1,
                    minPurchaseAmounts: { USDT: 100, BTC: 0.001, BUSD: 100 },
                    maxPurchaseAmount: -1,
                    maxPurchaseAmounts: { USDT: 100, BTC: 0.001, BUSD: 100 }
                  }
                ],
                lastBuyPriceRemoveThreshold: -1,
                lastBuyPriceRemoveThresholds: {
                  USDT: 5,
                  BTC: 0.00005,
                  BUSD: 5
                },
                athRestriction: {
                  enabled: true,
                  candles: { interval: '1d', limit: 30 },
                  restrictionPercentage: 0.9
                }
              },
              sell: {
                enabled: false,
                gridTrade: [
                  {
                    triggerPercentage: 1.08,
                    stopPercentage: 0.95,
                    limitPercentage: 0.949,
                    quantityPercentage: -1,
                    quantityPercentages: { USDT: 1, BTC: 1, BUSD: 1 }
                  }
                ],
                stopLoss: {
                  enabled: true,
                  maxLossPercentage: 0.95,
                  disableBuyMinutes: 60,
                  orderType: 'market'
                }
              },
              botOptions: {
                logs: {
                  deleteAfter: 30
                }
              },
              system: {
                temporaryDisableActionAfterConfirmingOrder: 10,
                checkManualBuyOrderPeriod: 10,
                placeManualOrderInterval: 5,
                refreshAccountInfoPeriod: 3,
                checkOrderExecutePeriod: 10
              }
            })
          );
        });

        it('returns expected value', () => {
          expect(result).toStrictEqual({
            enabled: true,
            cronTime: '* * * * * *',
            symbols: ['BNBUSDT', 'TRXBUSD', 'LTCUSDT', 'XRPBTC'],
            candles: { interval: '1d', limit: 10 },
            buy: {
              enabled: false,
              gridTrade: [
                {
                  triggerPercentage: 1,
                  stopPercentage: 1.02,
                  limitPercentage: 1.021,
                  minPurchaseAmount: -1,
                  minPurchaseAmounts: { USDT: 15, BTC: 0.002, BUSD: 30 },
                  maxPurchaseAmount: -1,
                  maxPurchaseAmounts: { USDT: 100, BTC: 0.005, BUSD: 100 }
                },
                {
                  triggerPercentage: 0.9,
                  stopPercentage: 1.02,
                  limitPercentage: 1.021,
                  minPurchaseAmount: -1,
                  minPurchaseAmounts: { USDT: 100, BTC: 0.001, BUSD: 100 },
                  maxPurchaseAmount: -1,
                  maxPurchaseAmounts: { USDT: 100, BTC: 0.001, BUSD: 100 }
                }
              ],
              lastBuyPriceRemoveThreshold: -1,
              lastBuyPriceRemoveThresholds: { USDT: 5, BTC: 0.00005, BUSD: 5 },
              athRestriction: {
                enabled: true,
                candles: { interval: '1d', limit: 30 },
                restrictionPercentage: 0.9
              }
            },
            sell: {
              enabled: false,
              gridTrade: [
                {
                  triggerPercentage: 1.08,
                  stopPercentage: 0.95,
                  limitPercentage: 0.949,
                  quantityPercentage: -1,
                  quantityPercentages: { USDT: 1, BTC: 1, BUSD: 1 }
                }
              ],
              stopLoss: {
                enabled: true,
                maxLossPercentage: 0.95,
                disableBuyMinutes: 60,
                orderType: 'market'
              }
            },
            botOptions: {
              logs: {
                deleteAfter: 30
              }
            },
            system: {
              temporaryDisableActionAfterConfirmingOrder: 10,
              checkManualBuyOrderPeriod: 10,
              placeManualOrderInterval: 5,
              refreshAccountInfoPeriod: 3,
              checkOrderExecutePeriod: 10
            }
          });
        });
      });
    });

    describe('with symbol', () => {
      describe('when cache is available', () => {
        beforeEach(async () => {
          cache.hget = jest.fn().mockImplementation((hash, key) => {
            if (hash === 'trailing-trade-configurations' && key === 'BTCUSDT') {
              return Promise.resolve(
                JSON.stringify({
                  symbol: 'configuration'
                })
              );
            }

            return Promise.resolve(null);
          });

          result = await configuration.getConfiguration(logger, 'BTCUSDT');
        });

        it('returns cached configruation', () => {
          expect(result).toStrictEqual({
            symbol: 'configuration'
          });
        });
      });

      describe('when cannot find global/symbol configurations', () => {
        beforeEach(async () => {
          mongo.findOne = jest.fn().mockResolvedValue(undefined);

          result = await configuration.getConfiguration(logger, 'BTCUSDT');
        });

        it('triggers mongo.findOne for global configuration', () => {
          expect(mongo.findOne).toHaveBeenCalledWith(
            logger,
            'trailing-trade-common',
            { key: 'configuration' }
          );
        });

        it('triggers mongo.findOne for symbol configuration', () => {
          expect(mongo.findOne).toHaveBeenCalledWith(
            logger,
            'trailing-trade-symbols',
            { key: 'BTCUSDT-configuration' }
          );
        });

        it('triggers config.get', () => {
          expect(config.get).toHaveBeenCalledWith('jobs.trailingTrade');
        });

        it('triggers mongo.upsertOne for global configuration', () => {
          expect(mongo.upsertOne).toHaveBeenCalledWith(
            logger,
            'trailing-trade-common',
            { key: 'configuration' },
            {
              key: 'configuration',
              enabled: true,
              cronTime: '* * * * * *',
              symbols: ['BTCUSDT', 'ETHUSDT', 'ETHBTC', 'XRPBTC'],
              candles: {
                interval: '1h',
                limit: 100
              },
              buy: {
                enabled: true,
                gridTrade: [
                  {
                    triggerPercentage: 1,
                    stopPercentage: 1.02,
                    limitPercentage: 1.021,
                    minPurchaseAmount: -1,
                    minPurchaseAmounts: {},
                    maxPurchaseAmount: -1,
                    maxPurchaseAmounts: {}
                  }
                ],
                lastBuyPriceRemoveThreshold: -1,
                lastBuyPriceRemoveThresholds: {
                  USDT: 10
                },
                athRestriction: {
                  enabled: true,
                  candles: {
                    interval: '1d',
                    limit: 30
                  },
                  restrictionPercentage: 0.9
                }
              },
              sell: {
                enabled: true,
                gridTrade: [
                  {
                    triggerPercentage: 1.06,
                    stopPercentage: 0.98,
                    limitPercentage: 0.979,
                    quantityPercentage: -1,
                    quantityPercentages: {}
                  }
                ],
                stopLoss: {
                  enabled: false,
                  maxLossPercentage: 0.8,
                  disableBuyMinutes: 360,
                  orderType: 'market'
                }
              },
              botOptions: {
                logs: {
                  deleteAfter: 30
                }
              },
              system: {
                temporaryDisableActionAfterConfirmingOrder: 20,
                checkManualBuyOrderPeriod: 5,
                placeManualOrderInterval: 5,
                refreshAccountInfoPeriod: 1,
                checkOrderExecutePeriod: 10
              }
            }
          );
        });

        it('returns epxected value', () => {
          expect(result).toStrictEqual({
            enabled: true,
            cronTime: '* * * * * *',
            symbols: ['BTCUSDT', 'ETHUSDT', 'ETHBTC', 'XRPBTC'],
            candles: { interval: '1h', limit: 100 },
            buy: {
              enabled: true,
              gridTrade: [
                {
                  triggerPercentage: 1,
                  stopPercentage: 1.02,
                  limitPercentage: 1.021,
                  minPurchaseAmount: 10,
                  maxPurchaseAmount: 100,
                  executed: false,
                  executedOrder: null
                }
              ],
              lastBuyPriceRemoveThreshold: 10,
              athRestriction: {
                enabled: true,
                candles: { interval: '1d', limit: 30 },
                restrictionPercentage: 0.9
              },
              currentGridTradeIndex: 0,
              currentGridTrade: {
                triggerPercentage: 1,
                stopPercentage: 1.02,
                limitPercentage: 1.021,
                minPurchaseAmount: 10,
                maxPurchaseAmount: 100,
                executed: false,
                executedOrder: null
              }
            },
            sell: {
              enabled: true,
              gridTrade: [
                {
                  triggerPercentage: 1.06,
                  stopPercentage: 0.98,
                  limitPercentage: 0.979,
                  quantityPercentage: 1,
                  executed: false,
                  executedOrder: null
                }
              ],
              stopLoss: {
                enabled: false,
                maxLossPercentage: 0.8,
                disableBuyMinutes: 360,
                orderType: 'market'
              },
              currentGridTradeIndex: 0,
              currentGridTrade: {
                triggerPercentage: 1.06,
                stopPercentage: 0.98,
                limitPercentage: 0.979,
                quantityPercentage: 1,
                executed: false,
                executedOrder: null
              }
            },
            botOptions: {
              logs: {
                deleteAfter: 30
              }
            },
            system: {
              temporaryDisableActionAfterConfirmingOrder: 20,
              checkManualBuyOrderPeriod: 5,
              placeManualOrderInterval: 5,
              refreshAccountInfoPeriod: 1,
              checkOrderExecutePeriod: 10
            }
          });
        });
      });

      describe('when found global configuration, but not symbol configuration', () => {
        describe('case 1', () => {
          beforeEach(async () => {
            mongo.findOne = jest.fn((_logger, collection, filter) => {
              if (
                collection === 'trailing-trade-common' &&
                _.isEqual(filter, { key: 'configuration' })
              ) {
                return {
                  enabled: true,
                  cronTime: '* * * * * *',
                  symbols: ['BNBUSDT', 'TRXBUSD', 'LTCUSDT', 'XRPBTC'],
                  candles: {
                    interval: '1d',
                    limit: 10
                  },
                  buy: {
                    enabled: false,
                    gridTrade: [
                      {
                        triggerPercentage: 1,
                        stopPercentage: 1.02,
                        limitPercentage: 1.021,
                        minPurchaseAmount: -1,
                        minPurchaseAmounts: {
                          USDT: 10,
                          BTC: 0.0001,
                          BUSD: 10
                        },
                        maxPurchaseAmount: -1,
                        maxPurchaseAmounts: {
                          USDT: 100,
                          BTC: 0.001,
                          BUSD: 100
                        }
                      },
                      {
                        triggerPercentage: 0.9,
                        stopPercentage: 1.02,
                        limitPercentage: 1.021,
                        minPurchaseAmount: -1,
                        minPurchaseAmounts: {
                          USDT: 50,
                          BTC: 0.0002,
                          BUSD: 50
                        },
                        maxPurchaseAmount: -1,
                        maxPurchaseAmounts: {
                          USDT: 100,
                          BTC: 0.001,
                          BUSD: 100
                        }
                      }
                    ],
                    lastBuyPriceRemoveThreshold: -1,
                    lastBuyPriceRemoveThresholds: {
                      USDT: 5,
                      BTC: 0.00005,
                      BUSD: 5
                    },
                    athRestriction: {
                      enabled: true,
                      candles: {
                        interval: '1d',
                        limit: 30
                      },
                      restrictionPercentage: 0.9
                    }
                  },
                  sell: {
                    enabled: false,
                    gridTrade: [
                      {
                        triggerPercentage: 1.08,
                        stopPercentage: 0.95,
                        limitPercentage: 0.949,
                        quantityPercentage: -1,
                        quantityPercentages: {
                          USDT: 0.5,
                          BTC: 0.5,
                          BUSD: 0.5
                        }
                      },
                      {
                        triggerPercentage: 1.1,
                        stopPercentage: 0.94,
                        limitPercentage: 0.939,
                        quantityPercentage: -1,
                        quantityPercentages: {
                          USDT: 1,
                          BTC: 1,
                          BUSD: 1
                        }
                      }
                    ],
                    stopLoss: {
                      enabled: true,
                      maxLossPercentage: 0.95,
                      disableBuyMinutes: 60,
                      orderType: 'market'
                    }
                  },
                  botOptions: {
                    logs: {
                      deleteAfter: 30
                    }
                  },
                  system: {
                    temporaryDisableActionAfterConfirmingOrder: 10,
                    checkManualBuyOrderPeriod: 10,
                    placeManualOrderInterval: 5,
                    refreshAccountInfoPeriod: 3,
                    checkOrderExecutePeriod: 10
                  }
                };
              }
              return null;
            });

            result = await configuration.getConfiguration(logger, 'BTCUSDT');
          });

          it('triggers config.get', () => {
            expect(config.get).toHaveBeenCalled();
          });

          it('does not triggers mongo.upsertOne', () => {
            expect(mongo.upsertOne).not.toHaveBeenCalled();
          });

          it('returns expected value', () => {
            expect(result).toStrictEqual({
              enabled: true,
              cronTime: '* * * * * *',
              symbols: ['BNBUSDT', 'TRXBUSD', 'LTCUSDT', 'XRPBTC'],
              candles: { interval: '1d', limit: 10 },
              buy: {
                enabled: false,
                gridTrade: [
                  {
                    triggerPercentage: 1,
                    stopPercentage: 1.02,
                    limitPercentage: 1.021,
                    minPurchaseAmount: 10,
                    maxPurchaseAmount: 100,
                    executed: false,
                    executedOrder: null
                  },
                  {
                    triggerPercentage: 0.9,
                    stopPercentage: 1.02,
                    limitPercentage: 1.021,
                    minPurchaseAmount: 50,
                    maxPurchaseAmount: 100,
                    executed: false,
                    executedOrder: null
                  }
                ],
                lastBuyPriceRemoveThreshold: 5,
                athRestriction: {
                  enabled: true,
                  candles: { interval: '1d', limit: 30 },
                  restrictionPercentage: 0.9
                },
                currentGridTradeIndex: 0,
                currentGridTrade: {
                  triggerPercentage: 1,
                  stopPercentage: 1.02,
                  limitPercentage: 1.021,
                  minPurchaseAmount: 10,
                  maxPurchaseAmount: 100,
                  executed: false,
                  executedOrder: null
                }
              },
              sell: {
                enabled: false,
                gridTrade: [
                  {
                    triggerPercentage: 1.08,
                    stopPercentage: 0.95,
                    limitPercentage: 0.949,
                    quantityPercentage: 0.5,
                    executed: false,
                    executedOrder: null
                  },
                  {
                    triggerPercentage: 1.1,
                    limitPercentage: 0.939,
                    stopPercentage: 0.94,
                    quantityPercentage: 1,
                    executed: false,
                    executedOrder: null
                  }
                ],
                stopLoss: {
                  enabled: true,
                  maxLossPercentage: 0.95,
                  disableBuyMinutes: 60,
                  orderType: 'market'
                },
                currentGridTradeIndex: 0,
                currentGridTrade: {
                  triggerPercentage: 1.08,
                  stopPercentage: 0.95,
                  limitPercentage: 0.949,
                  quantityPercentage: 0.5,
                  executed: false,
                  executedOrder: null
                }
              },
              botOptions: {
                logs: {
                  deleteAfter: 30
                }
              },
              system: {
                temporaryDisableActionAfterConfirmingOrder: 10,
                checkManualBuyOrderPeriod: 10,
                placeManualOrderInterval: 5,
                refreshAccountInfoPeriod: 3,
                checkOrderExecutePeriod: 10
              }
            });
          });
        });

        describe('case 2', () => {
          beforeEach(async () => {
            mongo.findOne = jest.fn((_logger, collection, filter) => {
              if (
                collection === 'trailing-trade-common' &&
                _.isEqual(filter, { key: 'configuration' })
              ) {
                return {
                  key: 'configuration',
                  enabled: true,
                  cronTime: '* * * * * *',
                  symbols: [
                    'ETHUSDT',
                    'CAKEUSDT',
                    'BNBUSDT',
                    'LTCUSDT',
                    'BTCUSDT'
                  ],
                  candles: { interval: '15m', limit: 50 },
                  buy: {
                    enabled: true,
                    athRestriction: {
                      enabled: false,
                      candles: { interval: '30m', limit: 50 },
                      restrictionPercentage: 0.9
                    },
                    lastBuyPriceRemoveThreshold: -1,
                    lastBuyPriceRemoveThresholds: { USDT: 5 },
                    gridTrade: [
                      {
                        triggerPercentage: 1,
                        stopPercentage: 1.025,
                        limitPercentage: 1.026,
                        minPurchaseAmount: -1,
                        minPurchaseAmounts: {
                          USDT: 10,
                          BTC: 0.001,
                          BUSD: 100,
                          ETH: 0.05
                        },
                        maxPurchaseAmount: -1,
                        maxPurchaseAmounts: {
                          USDT: 10,
                          BTC: 0.001,
                          BUSD: 100,
                          ETH: 0.05
                        }
                      },
                      {
                        triggerPercentage: 0.9,
                        stopPercentage: 1.025,
                        limitPercentage: 1.026,
                        minPurchaseAmount: -1,
                        minPurchaseAmounts: {
                          USDT: 10,
                          BTC: 0.001,
                          BUSD: 100,
                          ETH: 0.05
                        },
                        maxPurchaseAmount: -1,
                        maxPurchaseAmounts: {
                          USDT: 10,
                          BTC: 0.001,
                          BUSD: 100,
                          ETH: 0.05
                        }
                      },
                      {
                        triggerPercentage: 0.9,
                        stopPercentage: 1.025,
                        limitPercentage: 1.026,
                        minPurchaseAmount: -1,
                        minPurchaseAmounts: {
                          USDT: 10,
                          BTC: 0.001,
                          BUSD: 100,
                          ETH: 0.05
                        },
                        maxPurchaseAmount: -1,
                        maxPurchaseAmounts: {
                          USDT: 10,
                          BTC: 0.001,
                          BUSD: 100,
                          ETH: 0.05
                        }
                      }
                    ],
                    maxPurchaseAmount: -1
                  },
                  sell: {
                    enabled: true,
                    stopLoss: {
                      enabled: false,
                      maxLossPercentage: 0.8,
                      disableBuyMinutes: 360,
                      orderType: 'market'
                    },
                    gridTrade: [
                      {
                        triggerPercentage: 1.03,
                        stopPercentage: 0.985,
                        limitPercentage: 0.984,
                        quantityPercentage: -1,
                        quantityPercentages: { USDT: 0.8 }
                      },
                      {
                        triggerPercentage: 1.045,
                        stopPercentage: 0.975,
                        limitPercentage: 0.974,
                        quantityPercentage: -1,
                        quantityPercentages: { USDT: 1 }
                      }
                    ]
                  },
                  botOptions: {
                    logs: {
                      deleteAfter: 30
                    }
                  },
                  system: {
                    temporaryDisableActionAfterConfirmingOrder: 20,
                    checkManualBuyOrderPeriod: 10,
                    refreshAccountInfoPeriod: 1,
                    placeManualOrderInterval: 5,
                    checkOrderExecutePeriod: 10
                  }
                };
              }
              return null;
            });

            result = await configuration.getConfiguration(logger, 'BTCUSDT');
          });

          it('triggers config.get', () => {
            expect(config.get).toHaveBeenCalled();
          });

          it('does not triggers mongo.upsertOne', () => {
            expect(mongo.upsertOne).not.toHaveBeenCalled();
          });

          it('returns expected value', () => {
            expect(result).toStrictEqual({
              key: 'configuration',
              enabled: true,
              cronTime: '* * * * * *',
              symbols: ['ETHUSDT', 'CAKEUSDT', 'BNBUSDT', 'LTCUSDT', 'BTCUSDT'],
              candles: {
                interval: '15m',
                limit: 50
              },
              buy: {
                enabled: true,
                athRestriction: {
                  enabled: false,
                  candles: {
                    interval: '30m',
                    limit: 50
                  },
                  restrictionPercentage: 0.9
                },
                lastBuyPriceRemoveThreshold: 5,
                gridTrade: [
                  {
                    triggerPercentage: 1,
                    stopPercentage: 1.025,
                    limitPercentage: 1.026,
                    minPurchaseAmount: 10,
                    maxPurchaseAmount: 10,
                    executed: false,
                    executedOrder: null
                  },
                  {
                    triggerPercentage: 0.9,
                    stopPercentage: 1.025,
                    limitPercentage: 1.026,
                    minPurchaseAmount: 10,
                    maxPurchaseAmount: 10,
                    executed: false,
                    executedOrder: null
                  },
                  {
                    triggerPercentage: 0.9,
                    stopPercentage: 1.025,
                    limitPercentage: 1.026,
                    minPurchaseAmount: 10,
                    maxPurchaseAmount: 10,
                    executed: false,
                    executedOrder: null
                  }
                ],
                maxPurchaseAmount: -1,
                currentGridTradeIndex: 0,
                currentGridTrade: {
                  triggerPercentage: 1,
                  stopPercentage: 1.025,
                  limitPercentage: 1.026,
                  minPurchaseAmount: 10,
                  maxPurchaseAmount: 10,
                  executed: false,
                  executedOrder: null
                }
              },
              sell: {
                enabled: true,
                stopLoss: {
                  enabled: false,
                  maxLossPercentage: 0.8,
                  disableBuyMinutes: 360,
                  orderType: 'market'
                },
                gridTrade: [
                  {
                    triggerPercentage: 1.03,
                    stopPercentage: 0.985,
                    limitPercentage: 0.984,
                    quantityPercentage: 0.8,
                    executed: false,
                    executedOrder: null
                  },
                  {
                    triggerPercentage: 1.045,
                    stopPercentage: 0.975,
                    limitPercentage: 0.974,
                    quantityPercentage: 1,
                    executed: false,
                    executedOrder: null
                  }
                ],
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
              botOptions: {
                logs: {
                  deleteAfter: 30
                }
              },
              system: {
                temporaryDisableActionAfterConfirmingOrder: 20,
                checkManualBuyOrderPeriod: 10,
                refreshAccountInfoPeriod: 1,
                placeManualOrderInterval: 5,
                checkOrderExecutePeriod: 10
              }
            });
          });
        });
      });

      describe('when found global/symbol configuration', () => {
        describe('when configuration is not valid format', () => {
          beforeEach(async () => {
            mongo.findOne = jest.fn((_logger, collection, filter) => {
              if (
                collection === 'trailing-trade-common' &&
                _.isEqual(filter, { key: 'configuration' })
              ) {
                return {
                  enabled: true,
                  some: 'value',
                  buy: {
                    enabled: true
                  },
                  sell: { enabled: true }
                };
              }

              if (
                collection === 'trailing-trade-symbols' &&
                _.isEqual(filter, { key: 'BTCUSDT-configuration' })
              ) {
                return {
                  enabled: true,
                  some: 'symbol-value',
                  buy: { enabled: false },
                  sell: { enabled: false }
                };
              }
              return null;
            });

            result = await configuration.getConfiguration(logger, 'BTCUSDT');
          });

          it('returns expected value', () => {
            expect(result).toStrictEqual({
              enabled: true,
              cronTime: '* * * * * *',
              symbols: ['BTCUSDT', 'ETHUSDT', 'ETHBTC', 'XRPBTC'],
              candles: { interval: '1h', limit: 100 },
              some: 'symbol-value',
              buy: {
                enabled: false,
                gridTrade: [
                  {
                    triggerPercentage: 1,
                    stopPercentage: 1.02,
                    limitPercentage: 1.021,
                    minPurchaseAmount: 10,
                    maxPurchaseAmount: 100,
                    executed: false,
                    executedOrder: null
                  }
                ],
                lastBuyPriceRemoveThreshold: 10,
                athRestriction: {
                  enabled: true,
                  candles: { interval: '1d', limit: 30 },
                  restrictionPercentage: 0.9
                },
                currentGridTradeIndex: 0,
                currentGridTrade: {
                  triggerPercentage: 1,
                  stopPercentage: 1.02,
                  limitPercentage: 1.021,
                  minPurchaseAmount: 10,
                  maxPurchaseAmount: 100,
                  executed: false,
                  executedOrder: null
                }
              },
              sell: {
                enabled: false,
                gridTrade: [
                  {
                    triggerPercentage: 1.06,
                    stopPercentage: 0.98,
                    limitPercentage: 0.979,
                    quantityPercentage: 1,
                    executed: false,
                    executedOrder: null
                  }
                ],
                stopLoss: {
                  enabled: false,
                  maxLossPercentage: 0.8,
                  disableBuyMinutes: 360,
                  orderType: 'market'
                },
                currentGridTradeIndex: 0,
                currentGridTrade: {
                  triggerPercentage: 1.06,
                  stopPercentage: 0.98,
                  limitPercentage: 0.979,
                  quantityPercentage: 1,
                  executed: false,
                  executedOrder: null
                }
              },
              botOptions: {
                logs: {
                  deleteAfter: 30
                }
              },
              system: {
                temporaryDisableActionAfterConfirmingOrder: 20,
                checkManualBuyOrderPeriod: 5,
                placeManualOrderInterval: 5,
                refreshAccountInfoPeriod: 1,
                checkOrderExecutePeriod: 10
              }
            });
          });
        });

        describe('when cached symbol info is not valid', () => {
          beforeEach(async () => {
            cache.hget = jest.fn().mockResolvedValue(null);

            mongo.findOne = jest.fn((_logger, collection, filter) => {
              if (
                collection === 'trailing-trade-common' &&
                _.isEqual(filter, { key: 'configuration' })
              ) {
                return {
                  enabled: true,
                  some: 'value',
                  buy: {
                    enabled: true
                  },
                  sell: { enabled: true }
                };
              }

              if (
                collection === 'trailing-trade-symbols' &&
                _.isEqual(filter, { key: 'BTCUSDT-configuration' })
              ) {
                return {
                  enabled: true,
                  some: 'symbol-value',
                  buy: { enabled: false },
                  sell: { enabled: false }
                };
              }
              return null;
            });

            result = await configuration.getConfiguration(logger, 'BTCUSDT');
          });

          it('returns expected value', () => {
            expect(result).toStrictEqual({
              enabled: true,
              some: 'symbol-value',
              cronTime: '* * * * * *',
              symbols: ['BTCUSDT', 'ETHUSDT', 'ETHBTC', 'XRPBTC'],
              candles: { interval: '1h', limit: 100 },
              buy: {
                enabled: false,
                gridTrade: [
                  {
                    triggerPercentage: 1,
                    stopPercentage: 1.02,
                    limitPercentage: 1.021,
                    minPurchaseAmount: -1,
                    maxPurchaseAmount: -1,
                    executed: false,
                    executedOrder: null
                  }
                ],
                lastBuyPriceRemoveThreshold: -1,
                athRestriction: {
                  enabled: true,
                  candles: { interval: '1d', limit: 30 },
                  restrictionPercentage: 0.9
                },
                currentGridTradeIndex: 0,
                currentGridTrade: {
                  triggerPercentage: 1,
                  stopPercentage: 1.02,
                  limitPercentage: 1.021,
                  minPurchaseAmount: -1,
                  maxPurchaseAmount: -1,
                  executed: false,
                  executedOrder: null
                }
              },
              sell: {
                enabled: false,
                gridTrade: [
                  {
                    triggerPercentage: 1.06,
                    stopPercentage: 0.98,
                    limitPercentage: 0.979,
                    quantityPercentage: -1,
                    executed: false,
                    executedOrder: null
                  }
                ],
                stopLoss: {
                  enabled: false,
                  maxLossPercentage: 0.8,
                  disableBuyMinutes: 360,
                  orderType: 'market'
                },
                currentGridTradeIndex: 0,
                currentGridTrade: {
                  triggerPercentage: 1.06,
                  stopPercentage: 0.98,
                  limitPercentage: 0.979,
                  quantityPercentage: -1,
                  executed: false,
                  executedOrder: null
                }
              },
              botOptions: {
                logs: {
                  deleteAfter: 30
                }
              },
              system: {
                temporaryDisableActionAfterConfirmingOrder: 20,
                checkManualBuyOrderPeriod: 5,
                placeManualOrderInterval: 5,
                refreshAccountInfoPeriod: 1,
                checkOrderExecutePeriod: 10
              }
            });
          });
        });

        describe('when configuration are valid format', () => {
          describe('global configuration has different grid trade lengths', () => {
            describe('global configuration has more grid trade definitions', () => {
              beforeEach(async () => {
                mongo.findOne = jest.fn((_logger, collection, filter) => {
                  if (
                    collection === 'trailing-trade-common' &&
                    _.isEqual(filter, { key: 'configuration' })
                  ) {
                    return {
                      enabled: true,
                      cronTime: '* * * * * *',
                      symbols: ['BNBUSDT', 'TRXBUSD', 'LTCUSDT', 'XRPBTC'],
                      candles: {
                        interval: '1d',
                        limit: 10
                      },
                      buy: {
                        enabled: false,
                        gridTrade: [
                          {
                            triggerPercentage: 1,
                            stopPercentage: 1.02,
                            limitPercentage: 1.021,
                            minPurchaseAmount: -1,
                            minPurchaseAmounts: {
                              USDT: 10,
                              BTC: 0.0001,
                              BUSD: 10
                            },
                            maxPurchaseAmount: -1,
                            maxPurchaseAmounts: {
                              USDT: 100,
                              BTC: 0.001,
                              BUSD: 100
                            }
                          },
                          {
                            triggerPercentage: 0.9,
                            stopPercentage: 1.02,
                            limitPercentage: 1.021,
                            minPurchaseAmount: -1,
                            minPurchaseAmounts: {
                              USDT: 50,
                              BTC: 0.0005,
                              BUSD: 50
                            },
                            maxPurchaseAmount: -1,
                            maxPurchaseAmounts: {
                              USDT: 100,
                              BTC: 0.001,
                              BUSD: 100
                            }
                          },
                          {
                            triggerPercentage: 0.9,
                            stopPercentage: 1.02,
                            limitPercentage: 1.021,
                            minPurchaseAmount: -1,
                            minPurchaseAmounts: {
                              USDT: 100,
                              BTC: 0.001,
                              BUSD: 100
                            },
                            maxPurchaseAmount: -1,
                            maxPurchaseAmounts: {
                              USDT: 100,
                              BTC: 0.001,
                              BUSD: 100
                            }
                          },
                          {
                            triggerPercentage: 0.9,
                            stopPercentage: 1.02,
                            limitPercentage: 1.021,
                            minPurchaseAmount: -1,
                            minPurchaseAmounts: {
                              USDT: 100,
                              BTC: 0.001,
                              BUSD: 100
                            },
                            maxPurchaseAmount: -1,
                            maxPurchaseAmounts: {
                              USDT: 100,
                              BTC: 0.001,
                              BUSD: 100
                            }
                          }
                        ],
                        lastBuyPriceRemoveThreshold: -1,
                        lastBuyPriceRemoveThresholds: {
                          USDT: 5,
                          BTC: 0.00005,
                          BUSD: 5
                        },
                        athRestriction: {
                          enabled: true,
                          candles: {
                            interval: '1d',
                            limit: 30
                          },
                          restrictionPercentage: 0.9
                        }
                      },
                      sell: {
                        enabled: false,
                        gridTrade: [
                          {
                            triggerPercentage: 1.05,
                            stopPercentage: 0.95,
                            limitPercentage: 0.949,
                            quantityPercentage: -1,
                            quantityPercentages: {
                              USDT: 0.3,
                              BTC: 0.3,
                              BUSD: 0.3
                            }
                          },
                          {
                            triggerPercentage: 1.08,
                            stopPercentage: 0.95,
                            limitPercentage: 0.949,
                            quantityPercentage: -1,
                            quantityPercentages: {
                              USDT: 0.8,
                              BTC: 0.8,
                              BUSD: 0.8
                            }
                          },
                          {
                            triggerPercentage: 1.09,
                            stopPercentage: 0.95,
                            limitPercentage: 0.949,
                            quantityPercentage: -1,
                            quantityPercentages: {
                              USDT: 1,
                              BTC: 1,
                              BUSD: 1
                            }
                          }
                        ],
                        stopLoss: {
                          enabled: true,
                          maxLossPercentage: 0.95,
                          disableBuyMinutes: 60,
                          orderType: 'market'
                        }
                      },
                      system: {
                        temporaryDisableActionAfterConfirmingOrder: 10,
                        checkManualBuyOrderPeriod: 10,
                        placeManualOrderInterval: 5,
                        refreshAccountInfoPeriod: 3,
                        checkOrderExecutePeriod: 10
                      }
                    };
                  }

                  if (
                    collection === 'trailing-trade-symbols' &&
                    _.isEqual(filter, { key: 'BTCUSDT-configuration' })
                  ) {
                    return {
                      key: 'BTCUSDT-configuration',
                      candles: {
                        interval: '1h',
                        limit: 50
                      },
                      buy: {
                        enabled: true,
                        gridTrade: [
                          {
                            triggerPercentage: 1,
                            stopPercentage: 1.035,
                            limitPercentage: 1.036,
                            minPurchaseAmount: 11,
                            maxPurchaseAmount: 11
                          },
                          {
                            triggerPercentage: 0.9,
                            stopPercentage: 1.045,
                            limitPercentage: 1.046,
                            minPurchaseAmount: 10,
                            maxPurchaseAmount: 22
                          }
                        ],
                        lastBuyPriceRemoveThreshold: 5
                      },
                      sell: {
                        enabled: true,
                        gridTrade: [
                          {
                            triggerPercentage: 1.045,
                            stopPercentage: 0.975,
                            limitPercentage: 0.974,
                            quantityPercentage: 1,
                            quantityPercentages: {
                              USDT: 1
                            }
                          }
                        ],
                        stopLoss: {
                          enabled: true,
                          maxLossPercentage: 0.81,
                          disableBuyMinutes: 65,
                          orderType: 'market'
                        }
                      }
                    };
                  }
                  return null;
                });

                result = await configuration.getConfiguration(
                  logger,
                  'BTCUSDT'
                );
              });

              it('returns expected value', () => {
                expect(result).toStrictEqual({
                  key: 'BTCUSDT-configuration',
                  candles: { interval: '1h', limit: 50 },
                  enabled: true,
                  cronTime: '* * * * * *',
                  symbols: ['BNBUSDT', 'TRXBUSD', 'LTCUSDT', 'XRPBTC'],
                  buy: {
                    enabled: true,
                    gridTrade: [
                      {
                        triggerPercentage: 1,
                        stopPercentage: 1.035,
                        limitPercentage: 1.036,
                        minPurchaseAmount: 11,
                        maxPurchaseAmount: 11,
                        executed: false,
                        executedOrder: null
                      },
                      {
                        triggerPercentage: 0.9,
                        stopPercentage: 1.045,
                        limitPercentage: 1.046,
                        minPurchaseAmount: 10,
                        maxPurchaseAmount: 22,
                        executed: false,
                        executedOrder: null
                      }
                    ],
                    lastBuyPriceRemoveThreshold: 5,
                    athRestriction: {
                      enabled: true,
                      candles: { interval: '1d', limit: 30 },
                      restrictionPercentage: 0.9
                    },
                    currentGridTradeIndex: 0,
                    currentGridTrade: {
                      triggerPercentage: 1,
                      stopPercentage: 1.035,
                      limitPercentage: 1.036,
                      minPurchaseAmount: 11,
                      maxPurchaseAmount: 11,
                      executed: false,
                      executedOrder: null
                    }
                  },
                  sell: {
                    enabled: true,
                    gridTrade: [
                      {
                        triggerPercentage: 1.045,
                        stopPercentage: 0.975,
                        limitPercentage: 0.974,
                        quantityPercentage: 1,
                        executed: false,
                        executedOrder: null
                      }
                    ],
                    stopLoss: {
                      enabled: true,
                      maxLossPercentage: 0.81,
                      disableBuyMinutes: 65,
                      orderType: 'market'
                    },
                    currentGridTradeIndex: 0,
                    currentGridTrade: {
                      triggerPercentage: 1.045,
                      stopPercentage: 0.975,
                      limitPercentage: 0.974,
                      quantityPercentage: 1,
                      executed: false,
                      executedOrder: null
                    }
                  },
                  botOptions: {
                    logs: {
                      deleteAfter: 30
                    }
                  },
                  system: {
                    temporaryDisableActionAfterConfirmingOrder: 10,
                    checkManualBuyOrderPeriod: 10,
                    placeManualOrderInterval: 5,
                    refreshAccountInfoPeriod: 3,
                    checkOrderExecutePeriod: 10
                  }
                });
              });
            });

            describe('symbol configuration has more grid trade definitions', () => {
              beforeEach(async () => {
                mongo.findOne = jest.fn((_logger, collection, filter) => {
                  if (
                    collection === 'trailing-trade-common' &&
                    _.isEqual(filter, { key: 'configuration' })
                  ) {
                    return {
                      enabled: true,
                      cronTime: '* * * * * *',
                      symbols: ['BNBUSDT', 'TRXBUSD', 'LTCUSDT', 'XRPBTC'],
                      candles: {
                        interval: '1d',
                        limit: 10
                      },
                      buy: {
                        enabled: false,
                        gridTrade: [
                          {
                            triggerPercentage: 1,
                            stopPercentage: 1.02,
                            limitPercentage: 1.021,
                            minPurchaseAmount: -1,
                            minPurchaseAmounts: {
                              USDT: 10,
                              BTC: 0.0001,
                              BUSD: 10
                            },
                            maxPurchaseAmount: -1,
                            maxPurchaseAmounts: {
                              USDT: 100,
                              BTC: 0.001,
                              BUSD: 100
                            }
                          }
                        ],
                        lastBuyPriceRemoveThreshold: -1,
                        lastBuyPriceRemoveThresholds: {
                          USDT: 5,
                          BTC: 0.00005,
                          BUSD: 5
                        },
                        athRestriction: {
                          enabled: true,
                          candles: {
                            interval: '1d',
                            limit: 30
                          },
                          restrictionPercentage: 0.9
                        }
                      },
                      sell: {
                        enabled: false,
                        gridTrade: [
                          {
                            triggerPercentage: 1.05,
                            stopPercentage: 0.95,
                            limitPercentage: 0.949,
                            quantityPercentage: -1,
                            quantityPercentages: {
                              USDT: 0.3,
                              BTC: 0.3,
                              BUSD: 0.3
                            }
                          }
                        ],
                        stopLoss: {
                          enabled: true,
                          maxLossPercentage: 0.95,
                          disableBuyMinutes: 60,
                          orderType: 'market'
                        }
                      },
                      system: {
                        temporaryDisableActionAfterConfirmingOrder: 10,
                        checkManualBuyOrderPeriod: 10,
                        placeManualOrderInterval: 5,
                        refreshAccountInfoPeriod: 3,
                        checkOrderExecutePeriod: 10
                      }
                    };
                  }

                  if (
                    collection === 'trailing-trade-symbols' &&
                    _.isEqual(filter, { key: 'BTCUSDT-configuration' })
                  ) {
                    return {
                      key: 'BTCUSDT-configuration',
                      candles: {
                        interval: '1h',
                        limit: 50
                      },
                      buy: {
                        enabled: true,
                        gridTrade: [
                          {
                            triggerPercentage: 1,
                            stopPercentage: 1.035,
                            limitPercentage: 1.036,
                            minPurchaseAmount: 10,
                            maxPurchaseAmount: 11
                          },
                          {
                            triggerPercentage: 0.9,
                            stopPercentage: 1.045,
                            limitPercentage: 1.046,
                            minPurchaseAmount: 10,
                            maxPurchaseAmount: 22
                          },
                          {
                            triggerPercentage: 0.9,
                            stopPercentage: 1.055,
                            limitPercentage: 1.056,
                            minPurchaseAmount: 22,
                            maxPurchaseAmount: 22
                          },
                          {
                            triggerPercentage: 0.9,
                            stopPercentage: 1.065,
                            limitPercentage: 1.066,
                            minPurchaseAmount: 22,
                            maxPurchaseAmount: 22
                          }
                        ],
                        lastBuyPriceRemoveThreshold: 8
                      },
                      sell: {
                        enabled: true,
                        gridTrade: [
                          {
                            triggerPercentage: 1.045,
                            stopPercentage: 0.975,
                            limitPercentage: 0.974,
                            quantityPercentage: 0.5
                          },
                          {
                            triggerPercentage: 1.055,
                            stopPercentage: 0.965,
                            limitPercentage: 0.964,
                            quantityPercentage: 0.6
                          },
                          {
                            triggerPercentage: 1.045,
                            stopPercentage: 0.955,
                            limitPercentage: 0.954,
                            quantityPercentage: 1
                          }
                        ],
                        stopLoss: {
                          enabled: true,
                          maxLossPercentage: 0.81,
                          disableBuyMinutes: 65,
                          orderType: 'market'
                        }
                      }
                    };
                  }
                  return null;
                });

                result = await configuration.getConfiguration(
                  logger,
                  'BTCUSDT'
                );
              });

              it('returns expected value', () => {
                expect(result).toStrictEqual({
                  key: 'BTCUSDT-configuration',
                  candles: { interval: '1h', limit: 50 },
                  enabled: true,
                  cronTime: '* * * * * *',
                  symbols: ['BNBUSDT', 'TRXBUSD', 'LTCUSDT', 'XRPBTC'],
                  buy: {
                    enabled: true,
                    gridTrade: [
                      {
                        triggerPercentage: 1,
                        stopPercentage: 1.035,
                        limitPercentage: 1.036,
                        minPurchaseAmount: 10,
                        maxPurchaseAmount: 11,
                        executed: false,
                        executedOrder: null
                      },
                      {
                        triggerPercentage: 0.9,
                        stopPercentage: 1.045,
                        limitPercentage: 1.046,
                        minPurchaseAmount: 10,
                        maxPurchaseAmount: 22,
                        executed: false,
                        executedOrder: null
                      },
                      {
                        triggerPercentage: 0.9,
                        stopPercentage: 1.055,
                        limitPercentage: 1.056,
                        minPurchaseAmount: 22,
                        maxPurchaseAmount: 22,
                        executed: false,
                        executedOrder: null
                      },
                      {
                        triggerPercentage: 0.9,
                        stopPercentage: 1.065,
                        limitPercentage: 1.066,
                        minPurchaseAmount: 22,
                        maxPurchaseAmount: 22,
                        executed: false,
                        executedOrder: null
                      }
                    ],
                    lastBuyPriceRemoveThreshold: 8,
                    athRestriction: {
                      enabled: true,
                      candles: { interval: '1d', limit: 30 },
                      restrictionPercentage: 0.9
                    },
                    currentGridTradeIndex: 0,
                    currentGridTrade: {
                      triggerPercentage: 1,
                      stopPercentage: 1.035,
                      limitPercentage: 1.036,
                      minPurchaseAmount: 10,
                      maxPurchaseAmount: 11,
                      executed: false,
                      executedOrder: null
                    }
                  },
                  sell: {
                    enabled: true,
                    gridTrade: [
                      {
                        triggerPercentage: 1.045,
                        stopPercentage: 0.975,
                        limitPercentage: 0.974,
                        quantityPercentage: 0.5,
                        executed: false,
                        executedOrder: null
                      },
                      {
                        triggerPercentage: 1.055,
                        stopPercentage: 0.965,
                        limitPercentage: 0.964,
                        quantityPercentage: 0.6,
                        executed: false,
                        executedOrder: null
                      },
                      {
                        triggerPercentage: 1.045,
                        stopPercentage: 0.955,
                        limitPercentage: 0.954,
                        quantityPercentage: 1,
                        executed: false,
                        executedOrder: null
                      }
                    ],
                    stopLoss: {
                      enabled: true,
                      maxLossPercentage: 0.81,
                      disableBuyMinutes: 65,
                      orderType: 'market'
                    },
                    currentGridTradeIndex: 0,
                    currentGridTrade: {
                      triggerPercentage: 1.045,
                      stopPercentage: 0.975,
                      limitPercentage: 0.974,
                      quantityPercentage: 0.5,
                      executed: false,
                      executedOrder: null
                    }
                  },
                  botOptions: {
                    logs: {
                      deleteAfter: 30
                    }
                  },
                  system: {
                    temporaryDisableActionAfterConfirmingOrder: 10,
                    checkManualBuyOrderPeriod: 10,
                    placeManualOrderInterval: 5,
                    refreshAccountInfoPeriod: 3,
                    checkOrderExecutePeriod: 10
                  }
                });
              });
            });
          });

          describe('global configuration has same grid trade lengths', () => {
            beforeEach(async () => {
              mongo.findOne = jest.fn((_logger, collection, filter) => {
                if (
                  collection === 'trailing-trade-common' &&
                  _.isEqual(filter, { key: 'configuration' })
                ) {
                  return {
                    enabled: true,
                    cronTime: '* * * * * *',
                    symbols: ['BNBUSDT', 'TRXBUSD', 'LTCUSDT', 'XRPBTC'],
                    candles: {
                      interval: '1d',
                      limit: 10
                    },
                    buy: {
                      enabled: false,
                      gridTrade: [
                        {
                          triggerPercentage: 1,
                          stopPercentage: 1.02,
                          limitPercentage: 1.021,
                          minPurchaseAmount: -1,
                          minPurchaseAmounts: {
                            USDT: 10,
                            BTC: 0.0001,
                            BUSD: 10
                          },
                          maxPurchaseAmount: -1,
                          maxPurchaseAmounts: {
                            USDT: 100,
                            BTC: 0.001,
                            BUSD: 100
                          }
                        },
                        {
                          triggerPercentage: 0.9,
                          stopPercentage: 1.02,
                          limitPercentage: 1.021,
                          minPurchaseAmount: -1,
                          minPurchaseAmounts: {
                            USDT: 100,
                            BTC: 0.001,
                            BUSD: 100
                          },
                          maxPurchaseAmount: -1,
                          maxPurchaseAmounts: {
                            USDT: 100,
                            BTC: 0.001,
                            BUSD: 100
                          }
                        }
                      ],
                      lastBuyPriceRemoveThreshold: -1,
                      lastBuyPriceRemoveThresholds: {
                        USDT: 5,
                        BTC: 0.00005,
                        BUSD: 5
                      },
                      athRestriction: {
                        enabled: true,
                        candles: {
                          interval: '1d',
                          limit: 30
                        },
                        restrictionPercentage: 0.9
                      }
                    },
                    sell: {
                      enabled: false,
                      gridTrade: [
                        {
                          triggerPercentage: 1.08,
                          stopPercentage: 0.95,
                          limitPercentage: 0.949,
                          quantityPercentage: -1,
                          quantityPercentages: {
                            USDT: 1,
                            BTC: 1,
                            BUSD: 1
                          }
                        }
                      ],
                      stopLoss: {
                        enabled: true,
                        maxLossPercentage: 0.95,
                        disableBuyMinutes: 60,
                        orderType: 'market'
                      }
                    },
                    system: {
                      temporaryDisableActionAfterConfirmingOrder: 10,
                      checkManualBuyOrderPeriod: 10,
                      placeManualOrderInterval: 5,
                      refreshAccountInfoPeriod: 3,
                      checkOrderExecutePeriod: 10
                    }
                  };
                }

                if (
                  collection === 'trailing-trade-symbols' &&
                  _.isEqual(filter, { key: 'BTCUSDT-configuration' })
                ) {
                  return {
                    key: 'BTCUSDT-configuration',
                    candles: {
                      interval: '1h',
                      limit: 50
                    },
                    buy: {
                      enabled: true,
                      gridTrade: [
                        {
                          triggerPercentage: 1,
                          stopPercentage: 1.035,
                          limitPercentage: 1.036,
                          minPurchaseAmount: 11,
                          maxPurchaseAmount: 11
                        },
                        {
                          triggerPercentage: 0.9,
                          stopPercentage: 1.045,
                          limitPercentage: 1.046,
                          minPurchaseAmount: 15,
                          maxPurchaseAmount: 22
                        },
                        {
                          triggerPercentage: 0.9,
                          stopPercentage: 1.055,
                          limitPercentage: 1.056,
                          minPurchaseAmount: 33,
                          maxPurchaseAmount: 33
                        }
                      ],
                      lastBuyPriceRemoveThreshold: 5
                    },
                    sell: {
                      enabled: true,
                      gridTrade: [
                        {
                          triggerPercentage: 1.045,
                          stopPercentage: 0.975,
                          limitPercentage: 0.974,
                          quantityPercentage: 1,
                          quantityPercentages: {
                            USDT: 1
                          }
                        }
                      ],
                      stopLoss: {
                        enabled: true,
                        maxLossPercentage: 0.81,
                        disableBuyMinutes: 65,
                        orderType: 'market'
                      }
                    }
                  };
                }
                return null;
              });

              result = await configuration.getConfiguration(logger, 'BTCUSDT');
            });

            it('returns expected value', () => {
              expect(result).toStrictEqual({
                key: 'BTCUSDT-configuration',
                candles: { interval: '1h', limit: 50 },
                enabled: true,
                cronTime: '* * * * * *',
                symbols: ['BNBUSDT', 'TRXBUSD', 'LTCUSDT', 'XRPBTC'],
                buy: {
                  enabled: true,
                  gridTrade: [
                    {
                      triggerPercentage: 1,
                      stopPercentage: 1.035,
                      limitPercentage: 1.036,
                      minPurchaseAmount: 11,
                      maxPurchaseAmount: 11,
                      executed: false,
                      executedOrder: null
                    },
                    {
                      triggerPercentage: 0.9,
                      stopPercentage: 1.045,
                      limitPercentage: 1.046,
                      minPurchaseAmount: 15,
                      maxPurchaseAmount: 22,
                      executed: false,
                      executedOrder: null
                    },
                    {
                      triggerPercentage: 0.9,
                      stopPercentage: 1.055,
                      limitPercentage: 1.056,
                      minPurchaseAmount: 33,
                      maxPurchaseAmount: 33,
                      executed: false,
                      executedOrder: null
                    }
                  ],
                  lastBuyPriceRemoveThreshold: 5,
                  athRestriction: {
                    enabled: true,
                    candles: { interval: '1d', limit: 30 },
                    restrictionPercentage: 0.9
                  },
                  currentGridTradeIndex: 0,
                  currentGridTrade: {
                    triggerPercentage: 1,
                    stopPercentage: 1.035,
                    limitPercentage: 1.036,
                    minPurchaseAmount: 11,
                    maxPurchaseAmount: 11,
                    executed: false,
                    executedOrder: null
                  }
                },
                sell: {
                  enabled: true,
                  gridTrade: [
                    {
                      triggerPercentage: 1.045,
                      stopPercentage: 0.975,
                      limitPercentage: 0.974,
                      quantityPercentage: 1,
                      executed: false,
                      executedOrder: null
                    }
                  ],
                  stopLoss: {
                    enabled: true,
                    maxLossPercentage: 0.81,
                    disableBuyMinutes: 65,
                    orderType: 'market'
                  },
                  currentGridTradeIndex: 0,
                  currentGridTrade: {
                    triggerPercentage: 1.045,
                    stopPercentage: 0.975,
                    limitPercentage: 0.974,
                    quantityPercentage: 1,
                    executed: false,
                    executedOrder: null
                  }
                },
                botOptions: {
                  logs: {
                    deleteAfter: 30
                  }
                },
                system: {
                  temporaryDisableActionAfterConfirmingOrder: 10,
                  checkManualBuyOrderPeriod: 10,
                  placeManualOrderInterval: 5,
                  refreshAccountInfoPeriod: 3,
                  checkOrderExecutePeriod: 10
                }
              });
            });
          });
        });
      });
    });
  });
});
