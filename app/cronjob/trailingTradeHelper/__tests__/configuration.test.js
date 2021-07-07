const _ = require('lodash');
const config = require('config');
const configuration = require('../configuration');
const { logger, mongo, cache, PubSub } = require('../../../helpers');

jest.mock('config');
describe('configuration.js', () => {
  let result;

  describe('saveGlobalConfiguration', () => {
    beforeEach(async () => {
      PubSub.publish = jest.fn().mockReturnValue(true);
      mongo.upsertOne = jest.fn().mockResolvedValue(true);

      result = await configuration.saveGlobalConfiguration(logger, {
        myKey: 'value'
      });
    });

    it('triggers mongo.upsertOne with expected value', () => {
      expect(mongo.upsertOne).toHaveBeenCalledWith(
        logger,
        'trailing-trade-common',
        { key: 'configuration' },
        { key: 'configuration', myKey: 'value' }
      );
    });

    it('triggers PubSub.publish', () => {
      expect(PubSub.publish).toHaveBeenCalledWith(
        'reset-binance-websocket',
        true
      );
    });
  });

  describe('getGlobalConfiguration', () => {
    describe('when cannot find from mongodb', () => {
      beforeEach(async () => {
        mongo.upsertOne = jest.fn().mockResolvedValue(true);
        mongo.findOne = jest.fn((_logger, _collection, _filter) => null);
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
          }
        });
      });

      it('triggers mongo.upsertOne once', () => {
        expect(mongo.upsertOne).toHaveBeenCalledTimes(1);
      });
    });

    describe('when found from mongodb and configuration with stopLoss', () => {
      beforeEach(async () => {
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

  describe('saveSymbolConfiguration', () => {
    describe('when symbol is not provided', () => {
      beforeEach(async () => {
        mongo.upsertOne = jest.fn().mockResolvedValue(true);

        result = await configuration.saveSymbolConfiguration(logger);
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual({});
      });
    });

    describe('when symbol is provided', () => {
      beforeEach(async () => {
        mongo.upsertOne = jest.fn().mockResolvedValue(true);

        result = await configuration.saveSymbolConfiguration(
          logger,
          'BTCUSDT',
          {
            myKey: 'value'
          }
        );
      });

      it('triggers mongo.upsertOne', () => {
        expect(mongo.upsertOne).toHaveBeenCalledWith(
          logger,
          'trailing-trade-symbols',
          { key: 'BTCUSDT-configuration' },
          { key: 'BTCUSDT-configuration', myKey: 'value' }
        );
      });
    });
  });

  describe('deleteAllSymbolConfiguration', () => {
    beforeEach(async () => {
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
  });

  describe('deleteSymbolConfiguration', () => {
    beforeEach(async () => {
      mongo.deleteOne = jest.fn().mockResolvedValue(true);

      result = await configuration.deleteSymbolConfiguration(logger, 'BTCUSDT');
    });

    it('trigger mongo.deleteOne', () => {
      expect(mongo.deleteOne).toHaveBeenCalledWith(
        logger,
        'trailing-trade-symbols',
        {
          key: `BTCUSDT-configuration`
        }
      );
    });
  });

  describe('getConfiguration', () => {
    beforeEach(() => {
      mongo.upsertOne = jest.fn().mockResolvedValue(true);

      cache.hget = jest.fn().mockResolvedValue(
        JSON.stringify({
          quoteAsset: 'USDT',
          filterMinNotional: {
            minNotional: '10.00000000'
          }
        })
      );

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
              maxPurchaseAmounts: {
                USDT: 100
              },
              lastBuyPriceRemoveThreshold: -1,
              lastBuyPriceRemoveThresholds: {
                USDT: 10
              },
              triggerPercentage: 1.0,
              stopPercentage: 1.02,
              limitPercentage: 1.021,
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
              checkManualBuyOrderPeriod: 5,
              placeManualOrderInterval: 5,
              refreshAccountInfoPeriod: 1
            }
          };
        }
        return null;
      });
    });

    describe('without symbol', () => {
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
                maxPurchaseAmount: -1,
                maxPurchaseAmounts: {
                  USDT: 100,
                  BTC: 0.001,
                  BUSD: 100
                },
                lastBuyPriceRemoveThreshold: -1,
                lastBuyPriceRemoveThresholds: {
                  USDT: 5,
                  BTC: 0.00005,
                  BUSD: 5
                },
                triggerPercentage: 1.05,
                stopPercentage: 1.05,
                limitPercentage: 1.051,
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
                triggerPercentage: 1.08,
                stopPercentage: 0.95,
                limitPercentage: 0.949,
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
                refreshAccountInfoPeriod: 3
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
                maxPurchaseAmount: 150,
                lastBuyPriceRemoveThreshold: 4,
                triggerPercentage: 1.04,
                stopPercentage: 1.04,
                limitPercentage: 1.041
              },
              sell: {
                enabled: true,
                triggerPercentage: 1.06,
                stopPercentage: 0.96,
                limitPercentage: 0.979,
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

      it('returns expected value', () => {
        expect(result).toStrictEqual({
          enabled: true,
          cronTime: '* * * * * *',
          symbols: ['BNBUSDT', 'TRXBUSD', 'LTCUSDT', 'XRPBTC'],
          candles: { interval: '1d', limit: 10 },
          buy: {
            enabled: false,
            maxPurchaseAmount: -1,
            maxPurchaseAmounts: { USDT: 100, BTC: 0.001, BUSD: 100 },
            lastBuyPriceRemoveThreshold: -1,
            lastBuyPriceRemoveThresholds: {
              USDT: 5,
              BTC: 0.00005,
              BUSD: 5
            },
            triggerPercentage: 1.05,
            stopPercentage: 1.05,
            limitPercentage: 1.051,
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
            triggerPercentage: 1.08,
            stopPercentage: 0.95,
            limitPercentage: 0.949,
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
            refreshAccountInfoPeriod: 3
          }
        });
      });
    });

    describe('with symbol', () => {
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
              candles: { interval: '1h', limit: 100 },
              buy: {
                enabled: true,
                maxPurchaseAmount: -1,
                maxPurchaseAmounts: {
                  USDT: 100
                },
                lastBuyPriceRemoveThreshold: -1,
                lastBuyPriceRemoveThresholds: {
                  USDT: 10
                },
                triggerPercentage: 1,
                stopPercentage: 1.02,
                limitPercentage: 1.021,
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
                checkManualBuyOrderPeriod: 5,
                placeManualOrderInterval: 5,
                refreshAccountInfoPeriod: 1
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
              maxPurchaseAmount: 100,
              lastBuyPriceRemoveThreshold: 10,
              triggerPercentage: 1,
              stopPercentage: 1.02,
              limitPercentage: 1.021,
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
              checkManualBuyOrderPeriod: 5,
              placeManualOrderInterval: 5,
              refreshAccountInfoPeriod: 1
            }
          });
        });
      });

      describe('when found global configuration, but not symbol configuration', () => {
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
                  maxPurchaseAmount: -1,
                  maxPurchaseAmounts: {
                    USDT: 100,
                    BTC: 0.001,
                    BUSD: 100
                  },
                  lastBuyPriceRemoveThreshold: -1,
                  lastBuyPriceRemoveThresholds: {
                    USDT: 5,
                    BTC: 0.0004,
                    BUSD: 3
                  },
                  triggerPercentage: 1.05,
                  stopPercentage: 1.05,
                  limitPercentage: 1.051,
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
                  triggerPercentage: 1.08,
                  stopPercentage: 0.95,
                  limitPercentage: 0.949,
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
                  refreshAccountInfoPeriod: 3
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
              maxPurchaseAmount: 100,
              lastBuyPriceRemoveThreshold: 5,
              triggerPercentage: 1.05,
              stopPercentage: 1.05,
              limitPercentage: 1.051,
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
              triggerPercentage: 1.08,
              stopPercentage: 0.95,
              limitPercentage: 0.949,
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
              refreshAccountInfoPeriod: 3
            }
          });
        });
      });

      describe('when found global/symbol configuration', () => {
        describe('when symbol configuration buy max purchase amount/last buy price remove threshold are not -1', () => {
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
                    maxPurchaseAmount: -1,
                    maxPurchaseAmounts: {
                      USDT: 100,
                      BTC: 0.001,
                      BUSD: 100
                    },
                    lastBuyPriceRemoveThreshold: -1,
                    lastBuyPriceRemoveThresholds: {
                      USDT: 4,
                      BTC: 0.0008,
                      BUSD: 5
                    },
                    triggerPercentage: 1.05,
                    stopPercentage: 1.05,
                    limitPercentage: 1.051,
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
                    triggerPercentage: 1.08,
                    stopPercentage: 0.95,
                    limitPercentage: 0.949,
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
                    refreshAccountInfoPeriod: 3
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
                    maxPurchaseAmount: 150,
                    lastBuyPriceRemoveThreshold: 8,
                    triggerPercentage: 1.04,
                    stopPercentage: 1.04,
                    limitPercentage: 1.041,
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
                    triggerPercentage: 1.06,
                    stopPercentage: 0.96,
                    limitPercentage: 0.979,
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

          it('triggers config.get', () => {
            expect(config.get).toHaveBeenCalled();
          });

          it('does not trigger mongo.upsertOne', () => {
            expect(mongo.upsertOne).not.toHaveBeenCalled();
          });

          it('returns expected value', () => {
            expect(result).toStrictEqual({
              key: 'BTCUSDT-configuration',
              enabled: true,
              cronTime: '* * * * * *',
              symbols: ['BNBUSDT', 'TRXBUSD', 'LTCUSDT', 'XRPBTC'],
              candles: { interval: '1h', limit: 50 },
              buy: {
                enabled: true,
                maxPurchaseAmount: 150,
                lastBuyPriceRemoveThreshold: 8,
                triggerPercentage: 1.04,
                stopPercentage: 1.04,
                limitPercentage: 1.041,
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
                triggerPercentage: 1.06,
                stopPercentage: 0.96,
                limitPercentage: 0.979,
                stopLoss: {
                  enabled: true,
                  maxLossPercentage: 0.81,
                  disableBuyMinutes: 65,
                  orderType: 'market'
                }
              },
              system: {
                temporaryDisableActionAfterConfirmingOrder: 10,
                checkManualBuyOrderPeriod: 10,
                placeManualOrderInterval: 5,
                refreshAccountInfoPeriod: 3
              }
            });
          });
        });

        describe('when global configuration buy max purchase amount/last buy price moreve threshold are not -1', () => {
          beforeEach(async () => {
            cache.hget = jest.fn().mockResolvedValue(
              JSON.stringify({
                quoteAsset: 'USDT',
                filterMinNotional: {
                  minNotional: '10.00000000'
                }
              })
            );
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
                    maxPurchaseAmount: 50,
                    maxPurchaseAmounts: {
                      USDT: 100,
                      BTC: 0.001,
                      BUSD: 100
                    },
                    lastBuyPriceRemoveThreshold: 7,
                    lastBuyPriceRemoveThresholds: {
                      USDT: 5,
                      BTC: 0.0004,
                      BUSD: 4
                    },
                    triggerPercentage: 1.05,
                    stopPercentage: 1.05,
                    limitPercentage: 1.051,
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
                    triggerPercentage: 1.08,
                    stopPercentage: 0.95,
                    limitPercentage: 0.949,
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
                    refreshAccountInfoPeriod: 3
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
                    triggerPercentage: 1.04,
                    stopPercentage: 1.04,
                    limitPercentage: 1.041
                  },
                  sell: {
                    enabled: true,
                    triggerPercentage: 1.06,
                    stopPercentage: 0.96,
                    limitPercentage: 0.979,
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
              enabled: true,
              cronTime: '* * * * * *',
              symbols: ['BNBUSDT', 'TRXBUSD', 'LTCUSDT', 'XRPBTC'],
              candles: { interval: '1h', limit: 50 },
              buy: {
                enabled: true,
                maxPurchaseAmount: 50,
                lastBuyPriceRemoveThreshold: 7,
                triggerPercentage: 1.04,
                stopPercentage: 1.04,
                limitPercentage: 1.041,
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
                triggerPercentage: 1.06,
                stopPercentage: 0.96,
                limitPercentage: 0.979,
                stopLoss: {
                  enabled: true,
                  maxLossPercentage: 0.81,
                  disableBuyMinutes: 65,
                  orderType: 'market'
                }
              },
              system: {
                temporaryDisableActionAfterConfirmingOrder: 10,
                checkManualBuyOrderPeriod: 10,
                placeManualOrderInterval: 5,
                refreshAccountInfoPeriod: 3
              }
            });
          });
        });

        describe('when configuration is not valid format', () => {
          beforeEach(async () => {
            cache.hget = jest.fn().mockResolvedValue(
              JSON.stringify({
                quoteAsset: 'USDT',
                filterMinNotional: {
                  minNotional: '10.00000000'
                }
              })
            );
            mongo.findOne = jest.fn((_logger, collection, filter) => {
              if (
                collection === 'trailing-trade-common' &&
                _.isEqual(filter, { key: 'configuration' })
              ) {
                return {
                  enabled: true,
                  some: 'value',
                  buy: {
                    enabled: true,
                    maxPurchaseAmounts: { USDT: 80, BNB: 80 }
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
                  buy: { enabled: false, maxPurchaseAmount: -1 },
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
              buy: {
                enabled: false,
                maxPurchaseAmount: 80,
                lastBuyPriceRemoveThreshold: 10,
                triggerPercentage: 1,
                stopPercentage: 1.02,
                limitPercentage: 1.021,
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
              cronTime: '* * * * * *',
              symbols: ['BTCUSDT', 'ETHUSDT', 'ETHBTC', 'XRPBTC'],
              candles: { interval: '1h', limit: 100 },
              system: {
                temporaryDisableActionAfterConfirmingOrder: 20,
                checkManualBuyOrderPeriod: 5,
                placeManualOrderInterval: 5,
                refreshAccountInfoPeriod: 1
              }
            });
          });
        });

        describe('when symbol info is not cached', () => {
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
                  buy: { enabled: true, maxPurchaseAmounts: { BNB: 80 } },
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
                  buy: { enabled: false, maxPurchaseAmount: -1 },
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
                maxPurchaseAmount: -1,
                lastBuyPriceRemoveThreshold: -1,
                triggerPercentage: 1,
                stopPercentage: 1.02,
                limitPercentage: 1.021,
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
                checkManualBuyOrderPeriod: 5,
                placeManualOrderInterval: 5,
                refreshAccountInfoPeriod: 1
              }
            });
          });
        });
      });
    });
  });
});
