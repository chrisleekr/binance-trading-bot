const _ = require('lodash');
const config = require('config');
const configuration = require('../configuration');
const { logger, mongo } = require('../../../helpers');

jest.mock('config');
describe('configuration.js', () => {
  let result;

  describe('getGlobalConfiguration', () => {
    describe('when cannot find from mongodb', () => {
      beforeEach(async () => {
        mongo.findOne = jest.fn((_logger, _collection, _filter) => null);

        result = await configuration.getGlobalConfiguration(logger);
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual({});
      });
    });

    describe('when found from mongodb and configuration contains buy/sell', () => {
      beforeEach(async () => {
        mongo.findOne = jest.fn((_logger, collection, filter) => {
          if (
            collection === 'trailing-trade-common' &&
            _.isEqual(filter, { key: 'configuration' })
          ) {
            return {
              myConfig: 'value',
              buy: {
                enabled: false
              },
              sell: {
                enabled: false
              }
            };
          }
          return null;
        });

        result = await configuration.getGlobalConfiguration(logger);
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual({
          myConfig: 'value',
          buy: {
            enabled: false
          },
          sell: {
            enabled: false
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
              myConfig: 'value'
            };
          }
          return null;
        });

        result = await configuration.getSymbolConfiguration(logger, 'BTCUSDT');
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({ myConfig: 'value' });
      });
    });
  });

  describe('saveGlobalConfiguration', () => {
    beforeEach(async () => {
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

  describe('getConfiguration', () => {
    beforeEach(() => {
      mongo.upsertOne = jest.fn().mockResolvedValue(true);

      config.get = jest.fn(key => {
        if (key === 'jobs.trailingTrade') {
          return {
            enabled: true,
            buy: {
              enabled: true
            },
            sell: {
              enabled: false
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
              some: 'value'
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

      it('does not triggers config.get', () => {
        expect(config.get).not.toHaveBeenCalled();
      });

      it('does not triggers mongo.upsertOne', () => {
        expect(mongo.upsertOne).not.toHaveBeenCalled();
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual({
          enabled: true,
          some: 'value'
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
                enabled: false
              }
            }
          );
        });

        it('returns epxected value', () => {
          expect(result).toStrictEqual({
            enabled: true,
            buy: {
              enabled: true
            },
            sell: {
              enabled: false
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
                some: 'value'
              };
            }
            return null;
          });

          result = await configuration.getConfiguration(logger, 'BTCUSDT');
        });

        it('does not triggers config.get', () => {
          expect(config.get).not.toHaveBeenCalled();
        });

        it('does not triggers mongo.upsertOne', () => {
          expect(mongo.upsertOne).not.toHaveBeenCalled();
        });

        it('returns expected value', () => {
          expect(result).toStrictEqual({
            enabled: true,
            some: 'value'
          });
        });
      });

      describe('when found global/symbol configuration', () => {
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
                buy: { enabled: false },
                sell: { enabled: false }
              };
            }
            return null;
          });

          result = await configuration.getConfiguration(logger, 'BTCUSDT');
        });

        it('does not triggers config.get', () => {
          expect(config.get).not.toHaveBeenCalled();
        });

        it('does not triggers mongo.upsertOne', () => {
          expect(mongo.upsertOne).not.toHaveBeenCalled();
        });

        it('returns expected value', () => {
          expect(result).toStrictEqual({
            enabled: true,
            some: 'symbol-value',
            buy: { enabled: false },
            sell: { enabled: false }
          });
        });
      });
    });
  });
});
