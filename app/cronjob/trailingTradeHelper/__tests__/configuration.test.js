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
        'trailing-trade-configuration-changed',
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
        mongo.findOne = jest.fn((_logger, collection, filter) => {
          if (
            collection === 'trailing-trade-common' &&
            _.isEqual(filter, { key: 'configuration' })
          ) {
            return {
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

      it('returns expected value', () => {
        expect(result).toStrictEqual({
          sell: {
            stopLoss: {
              enabled: true,
              key: 'value'
            }
          }
        });
      });
    });

    describe('when found from mongodb and configuration without stopLoss', () => {
      beforeEach(async () => {
        config.get = jest.fn(key => {
          if (key === 'jobs.trailingTrade') {
            return {
              enabled: true,
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

        mongo.findOne = jest.fn((_logger, collection, filter) => {
          if (
            collection === 'trailing-trade-common' &&
            _.isEqual(filter, { key: 'configuration' })
          ) {
            return {
              sell: {}
            };
          }
          return null;
        });

        result = await configuration.getGlobalConfiguration(logger);
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual({
          sell: {
            stopLoss: {
              enabled: true,
              key: 'value'
            }
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
          filterMinNotional: {
            minNotional: '10.00000000'
          }
        })
      );

      config.get = jest.fn(key => {
        if (key === 'jobs.trailingTrade') {
          return {
            enabled: true,
            buy: {
              enabled: true
            },
            sell: {
              enabled: false,
              stopLoss: { enabled: true }
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
              some: 'value',
              sell: {}
            };
          }
          if (
            collection === 'trailing-trade-symbols' &&
            _.isEqual(filter, { key: 'BTCUSDT-configuration' })
          ) {
            return {
              enabled: true,
              some: 'BTCUSDT-value'
            };
          }
          return null;
        });

        result = await configuration.getConfiguration(logger);
      });

      it('triggers config.get', () => {
        expect(config.get).toHaveBeenCalled();
      });

      it('triggers mongo.upsertOne', () => {
        expect(mongo.upsertOne).toHaveBeenCalled();
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual({
          enabled: true,
          some: 'value',
          sell: {
            stopLoss: { enabled: true }
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
              buy: {
                enabled: true
              },
              sell: {
                enabled: false,
                stopLoss: {
                  enabled: true
                }
              }
            }
          );
        });

        it('returns epxected value', () => {
          expect(result).toStrictEqual({
            enabled: true,
            buy: {
              enabled: true,
              maxPurchaseAmount: 100
            },
            sell: {
              enabled: false,
              stopLoss: {
                enabled: true
              }
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
                some: 'value',
                sell: {}
              };
            }
            return null;
          });

          result = await configuration.getConfiguration(logger, 'BTCUSDT');
        });

        it('triggers config.get', () => {
          expect(config.get).toHaveBeenCalled();
        });

        it('triggers mongo.upsertOne', () => {
          expect(mongo.upsertOne).toHaveBeenCalled();
        });

        it('returns expected value', () => {
          expect(result).toStrictEqual({
            enabled: true,
            some: 'value',
            buy: {
              maxPurchaseAmount: 100
            },
            sell: {
              stopLoss: {
                enabled: true
              }
            }
          });
        });
      });

      describe('when found global/symbol configuration', () => {
        describe('when symbol configuration buy max purchase amount is not -1', () => {
          beforeEach(async () => {
            mongo.findOne = jest.fn((_logger, collection, filter) => {
              if (
                collection === 'trailing-trade-common' &&
                _.isEqual(filter, { key: 'configuration' })
              ) {
                return {
                  enabled: true,
                  some: 'value',
                  buy: { enabled: true },
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
                  buy: { enabled: false, maxPurchaseAmount: 100 },
                  sell: { enabled: false }
                };
              }
              return null;
            });

            result = await configuration.getConfiguration(logger, 'BTCUSDT');
          });

          it('triggers config.get', () => {
            expect(config.get).toHaveBeenCalled();
          });

          it('triggers mongo.upsertOne', () => {
            expect(mongo.upsertOne).toHaveBeenCalled();
          });

          it('returns expected value', () => {
            expect(result).toStrictEqual({
              enabled: true,
              some: 'symbol-value',
              buy: { enabled: false, maxPurchaseAmount: 100 },
              sell: {
                enabled: false,
                stopLoss: {
                  enabled: true
                }
              }
            });
          });
        });

        describe('when global configuration buy max purchase amount is not -1', () => {
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
                  buy: { enabled: true, maxPurchaseAmounts: { USDT: 80 } },
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
              buy: { enabled: false, maxPurchaseAmount: 80 },
              sell: {
                enabled: false,
                stopLoss: {
                  enabled: true
                }
              }
            });
          });
        });

        describe('when global configuration buy max purchase amount is -1', () => {
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
              buy: { enabled: false, maxPurchaseAmount: 100 },
              sell: {
                enabled: false,
                stopLoss: {
                  enabled: true
                }
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
              buy: { enabled: false, maxPurchaseAmount: -1 },
              sell: {
                enabled: false,
                stopLoss: {
                  enabled: true
                }
              }
            });
          });
        });
      });
    });
  });
});
