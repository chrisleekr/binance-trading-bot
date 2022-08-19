/* eslint-disable global-require */
const logger = require('../logger');

describe('mongo.js', () => {
  let mockDB;
  let mockDBCommand;
  let mockMongoClient;

  let mongo;

  let result;
  let mockCollection;
  let mockCount;
  let mockFind;
  let mockFindOne;
  let mockAggregate;
  let mockInsertOne;
  let mockUpdateOne;
  let mockDeleteMany;
  let mockDeleteOne;
  let mockCreateIndex;
  let mockDropIndex;
  let mockBulkWrite;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();
  });

  describe('connect', () => {
    describe('when connect is failed', () => {
      beforeEach(async () => {
        process.exit = jest.fn();

        mockMongoClient = jest.fn(() => ({
          connect: jest.fn().mockRejectedValue(new Error('connection failed'))
        }));

        jest.mock('mongodb', () => ({
          MongoClient: mockMongoClient
        }));

        require('mongodb');

        mongo = require('../mongo');

        await mongo.connect(logger);
      });

      it('triggers process.exit', () => {
        expect(process.exit).toHaveBeenCalledWith(1);
      });
    });

    describe('when connect is succeed', () => {
      beforeEach(async () => {
        mockDBCommand = jest.fn().mockResolvedValue(true);
        mockDB = jest.fn(() => ({
          command: mockDBCommand
        }));

        mockMongoClient = jest.fn(() => ({
          connect: jest.fn().mockResolvedValue(true),
          db: mockDB
        }));

        jest.mock('mongodb', () => ({
          MongoClient: mockMongoClient
        }));

        require('mongodb');

        mongo = require('../mongo');

        await mongo.connect(logger);
      });

      it('triggers MongoClient', () => {
        expect(mockMongoClient).toHaveBeenCalledWith(
          'mongodb://binance-mongo:27017/?retryWrites=true&writeConcern=majority',
          {
            useNewUrlParser: true,
            useUnifiedTopology: true
          }
        );
      });

      it('triggers client.DB', () => {
        expect(mockDB).toHaveBeenCalledWith('admin');
        expect(mockDB).toHaveBeenCalledWith('binance-bot');
      });

      it('triggers client.db().command', () => {
        expect(mockDBCommand).toHaveBeenCalledWith({ ping: 1 });
      });

      it('does not triggers process.exit', () => {
        expect(process.exit).not.toHaveBeenCalled();
      });
    });
  });

  describe('count', () => {
    beforeEach(async () => {
      mockCount = jest.fn().mockReturnValue(3);
      mockCollection = jest.fn(() => ({
        count: mockCount
      }));

      mockDBCommand = jest.fn().mockResolvedValue(true);
      mockDB = jest.fn(() => ({
        command: mockDBCommand,
        collection: mockCollection
      }));

      mockMongoClient = jest.fn(() => ({
        connect: jest.fn().mockResolvedValue(true),
        db: mockDB
      }));

      jest.mock('mongodb', () => ({
        MongoClient: mockMongoClient
      }));

      require('mongodb');

      mongo = require('../mongo');

      await mongo.connect(logger);

      result = await mongo.count(logger, 'trailing-trade-symbols', {
        key: {
          $regex: '(BTCUSDT|BNBUSDT)-last-buy-price'
        }
      });
    });

    it('triggers database.collection', () => {
      expect(mockCollection).toHaveBeenCalledWith('trailing-trade-symbols');
    });

    it('triggers collection.count', () => {
      expect(mockCount).toHaveBeenCalledWith({
        key: {
          $regex: '(BTCUSDT|BNBUSDT)-last-buy-price'
        }
      });
    });

    it('returns expected result', () => {
      expect(result).toStrictEqual(3);
    });
  });

  describe('findAll', () => {
    describe('with params', () => {
      beforeEach(async () => {
        mockFind = jest.fn().mockReturnValue({
          toArray: jest.fn().mockResolvedValue([
            { key: 'my-key1', some: 'value' },
            { key: 'my-key2', some: 'value' }
          ])
        });
        mockCollection = jest.fn(() => ({
          find: mockFind
        }));

        mockDBCommand = jest.fn().mockResolvedValue(true);
        mockDB = jest.fn(() => ({
          command: mockDBCommand,
          collection: mockCollection
        }));

        mockMongoClient = jest.fn(() => ({
          connect: jest.fn().mockResolvedValue(true),
          db: mockDB
        }));

        jest.mock('mongodb', () => ({
          MongoClient: mockMongoClient
        }));

        require('mongodb');

        mongo = require('../mongo');

        await mongo.connect(logger);

        result = await mongo.findAll(
          logger,
          'trailing-trade-grid-trade',
          {
            key: 'BTCUSDT'
          },
          {
            limit: 5
          }
        );
      });

      it('triggers database.collection', () => {
        expect(mockCollection).toHaveBeenCalledWith(
          'trailing-trade-grid-trade'
        );
      });

      it('triggers collection.find', () => {
        expect(mockFind).toHaveBeenCalledWith(
          {
            key: 'BTCUSDT'
          },
          {
            limit: 5
          }
        );
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual([
          { key: 'my-key1', some: 'value' },
          { key: 'my-key2', some: 'value' }
        ]);
      });
    });

    describe('without params', () => {
      beforeEach(async () => {
        mockFind = jest.fn().mockReturnValue({
          toArray: jest.fn().mockResolvedValue([
            { key: 'my-key1', some: 'value' },
            { key: 'my-key2', some: 'value' }
          ])
        });
        mockCollection = jest.fn(() => ({
          find: mockFind
        }));

        mockDBCommand = jest.fn().mockResolvedValue(true);
        mockDB = jest.fn(() => ({
          command: mockDBCommand,
          collection: mockCollection
        }));

        mockMongoClient = jest.fn(() => ({
          connect: jest.fn().mockResolvedValue(true),
          db: mockDB
        }));

        jest.mock('mongodb', () => ({
          MongoClient: mockMongoClient
        }));

        require('mongodb');

        mongo = require('../mongo');

        await mongo.connect(logger);

        result = await mongo.findAll(logger, 'trailing-trade-grid-trade', {
          key: 'BTCUSDT'
        });
      });

      it('triggers database.collection', () => {
        expect(mockCollection).toHaveBeenCalledWith(
          'trailing-trade-grid-trade'
        );
      });

      it('triggers collection.find', () => {
        expect(mockFind).toHaveBeenCalledWith(
          {
            key: 'BTCUSDT'
          },
          {}
        );
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual([
          { key: 'my-key1', some: 'value' },
          { key: 'my-key2', some: 'value' }
        ]);
      });
    });
  });

  describe('aggregate', () => {
    beforeEach(async () => {
      mockAggregate = jest.fn().mockReturnValue({
        toArray: jest.fn().mockResolvedValue([
          { key: 'my-key1', some: 'value' },
          { key: 'my-key2', some: 'value' }
        ])
      });
      mockCollection = jest.fn(() => ({
        aggregate: mockAggregate
      }));

      mockDBCommand = jest.fn().mockResolvedValue(true);
      mockDB = jest.fn(() => ({
        command: mockDBCommand,
        collection: mockCollection
      }));

      mockMongoClient = jest.fn(() => ({
        connect: jest.fn().mockResolvedValue(true),
        db: mockDB
      }));

      jest.mock('mongodb', () => ({
        MongoClient: mockMongoClient
      }));

      require('mongodb');

      mongo = require('../mongo');

      await mongo.connect(logger);

      result = await mongo.aggregate(logger, 'trailing-trade-grid-trade', {
        key: 'BTCUSDT'
      });
    });

    it('triggers database.collection', () => {
      expect(mockCollection).toHaveBeenCalledWith('trailing-trade-grid-trade');
    });

    it('triggers collection.find', () => {
      expect(mockAggregate).toHaveBeenCalledWith({
        key: 'BTCUSDT'
      });
    });

    it('returns expected result', () => {
      expect(result).toStrictEqual([
        { key: 'my-key1', some: 'value' },
        { key: 'my-key2', some: 'value' }
      ]);
    });
  });

  describe('findOne', () => {
    beforeEach(async () => {
      mockFindOne = jest
        .fn()
        .mockResolvedValue({ key: 'my-key', some: 'value' });
      mockCollection = jest.fn(() => ({
        findOne: mockFindOne
      }));

      mockDBCommand = jest.fn().mockResolvedValue(true);
      mockDB = jest.fn(() => ({
        command: mockDBCommand,
        collection: mockCollection
      }));

      mockMongoClient = jest.fn(() => ({
        connect: jest.fn().mockResolvedValue(true),
        db: mockDB
      }));

      jest.mock('mongodb', () => ({
        MongoClient: mockMongoClient
      }));

      require('mongodb');

      mongo = require('../mongo');

      await mongo.connect(logger);

      result = await mongo.findOne(logger, 'trailing-stop-common', {
        key: 'configuration'
      });
    });

    it('triggers database.collection', () => {
      expect(mockCollection).toHaveBeenCalledWith('trailing-stop-common');
    });

    it('triggers collection.findOne', () => {
      expect(mockFindOne).toHaveBeenCalledWith({
        key: 'configuration'
      });
    });

    it('returns expected result', () => {
      expect(result).toStrictEqual({
        key: 'my-key',
        some: 'value'
      });
    });
  });

  describe('insertOne', () => {
    beforeEach(async () => {
      mockInsertOne = jest.fn().mockResolvedValue(true);
      mockCollection = jest.fn(() => ({
        insertOne: mockInsertOne
      }));

      mockDBCommand = jest.fn().mockResolvedValue(true);
      mockDB = jest.fn(() => ({
        command: mockDBCommand,
        collection: mockCollection
      }));

      mockMongoClient = jest.fn(() => ({
        connect: jest.fn().mockResolvedValue(true),
        db: mockDB
      }));

      jest.mock('mongodb', () => ({
        MongoClient: mockMongoClient
      }));

      require('mongodb');

      mongo = require('../mongo');

      await mongo.connect(logger);

      result = await mongo.insertOne(logger, 'trailing-stop-common', {
        key: 'configuration',
        my: 'value'
      });
    });

    it('triggers database.collection', () => {
      expect(mockCollection).toHaveBeenCalledWith('trailing-stop-common');
    });

    it('triggers collection.insertOne', () => {
      expect(mockInsertOne).toHaveBeenCalledWith(
        {
          key: 'configuration',
          my: 'value'
        },
        {
          writeConcern: {
            w: 0,
            j: false
          }
        }
      );
    });

    it('returns expected result', () => {
      expect(result).toStrictEqual(true);
    });
  });

  describe('upsertOne', () => {
    beforeEach(async () => {
      mockUpdateOne = jest.fn().mockResolvedValue(true);
      mockCollection = jest.fn(() => ({
        updateOne: mockUpdateOne
      }));

      mockDBCommand = jest.fn().mockResolvedValue(true);
      mockDB = jest.fn(() => ({
        command: mockDBCommand,
        collection: mockCollection
      }));

      mockMongoClient = jest.fn(() => ({
        connect: jest.fn().mockResolvedValue(true),
        db: mockDB
      }));

      jest.mock('mongodb', () => ({
        MongoClient: mockMongoClient
      }));

      require('mongodb');

      mongo = require('../mongo');

      await mongo.connect(logger);

      result = await mongo.upsertOne(
        logger,
        'trailing-stop-common',
        {
          key: 'configuration'
        },
        {
          key: 'configuration',
          my: 'value'
        }
      );
    });

    it('triggers database.collection', () => {
      expect(mockCollection).toHaveBeenCalledWith('trailing-stop-common');
    });

    it('triggers collection.upsertOne', () => {
      expect(mockUpdateOne).toHaveBeenCalledWith(
        {
          key: 'configuration'
        },
        {
          $set: {
            key: 'configuration',
            my: 'value'
          }
        },
        {
          upsert: true,
          writeConcern: {
            w: 0,
            j: false
          }
        }
      );
    });

    it('returns expected result', () => {
      expect(result).toStrictEqual(true);
    });
  });

  describe('deleteAll', () => {
    beforeEach(async () => {
      mockDeleteMany = jest.fn().mockResolvedValue(true);
      mockCollection = jest.fn(() => ({
        deleteMany: mockDeleteMany
      }));

      mockDBCommand = jest.fn().mockResolvedValue(true);
      mockDB = jest.fn(() => ({
        command: mockDBCommand,
        collection: mockCollection
      }));

      mockMongoClient = jest.fn(() => ({
        connect: jest.fn().mockResolvedValue(true),
        db: mockDB
      }));

      jest.mock('mongodb', () => ({
        MongoClient: mockMongoClient
      }));

      require('mongodb');

      mongo = require('../mongo');

      await mongo.connect(logger);

      result = await mongo.deleteAll(logger, 'trailing-stop-common', {
        key: 'configuration'
      });
    });

    it('triggers database.collection', () => {
      expect(mockCollection).toHaveBeenCalledWith('trailing-stop-common');
    });

    it('triggers collection.deleteMany', () => {
      expect(mockDeleteMany).toHaveBeenCalledWith(
        {
          key: 'configuration'
        },
        {
          writeConcern: {
            w: 0,
            j: false
          }
        }
      );
    });

    it('returns expected result', () => {
      expect(result).toStrictEqual(true);
    });
  });

  describe('deleteOne', () => {
    beforeEach(async () => {
      mockDeleteOne = jest.fn().mockResolvedValue(true);
      mockCollection = jest.fn(() => ({
        deleteOne: mockDeleteOne
      }));

      mockDBCommand = jest.fn().mockResolvedValue(true);
      mockDB = jest.fn(() => ({
        command: mockDBCommand,
        collection: mockCollection
      }));

      mockMongoClient = jest.fn(() => ({
        connect: jest.fn().mockResolvedValue(true),
        db: mockDB
      }));

      jest.mock('mongodb', () => ({
        MongoClient: mockMongoClient
      }));

      require('mongodb');

      mongo = require('../mongo');

      await mongo.connect(logger);

      result = await mongo.deleteOne(logger, 'trailing-stop-common', {
        key: 'configuration'
      });
    });

    it('triggers database.collection', () => {
      expect(mockCollection).toHaveBeenCalledWith('trailing-stop-common');
    });

    it('triggers collection.deleteOne', () => {
      expect(mockDeleteOne).toHaveBeenCalledWith(
        {
          key: 'configuration'
        },
        {
          writeConcern: {
            w: 0,
            j: false
          }
        }
      );
    });

    it('returns expected result', () => {
      expect(result).toStrictEqual(true);
    });
  });

  describe('createIndex', () => {
    beforeEach(async () => {
      mockCreateIndex = jest.fn().mockResolvedValue(true);
      mockCollection = jest.fn(() => ({
        createIndex: mockCreateIndex
      }));

      mockDBCommand = jest.fn().mockResolvedValue(true);
      mockDB = jest.fn(() => ({
        command: mockDBCommand,
        collection: mockCollection
      }));

      mockMongoClient = jest.fn(() => ({
        connect: jest.fn().mockResolvedValue(true),
        db: mockDB
      }));

      jest.mock('mongodb', () => ({
        MongoClient: mockMongoClient
      }));

      require('mongodb');

      mongo = require('../mongo');

      await mongo.connect(logger);

      result = await mongo.createIndex(
        logger,
        'trailing-trade-logs',
        {
          loggedAt: 1
        },
        {
          name: 'trailing-trade-logs-logs-idx',
          background: true,
          expireAfterSeconds: 1800
        }
      );
    });

    it('triggers database.collection', () => {
      expect(mockCollection).toHaveBeenCalledWith('trailing-trade-logs');
    });

    it('triggers collection.createIndex', () => {
      expect(mockCreateIndex).toHaveBeenCalledWith(
        {
          loggedAt: 1
        },
        {
          name: 'trailing-trade-logs-logs-idx',
          background: true,
          expireAfterSeconds: 1800
        }
      );
    });

    it('returns expected result', () => {
      expect(result).toStrictEqual(true);
    });
  });

  describe('dropIndex', () => {
    beforeEach(async () => {
      mockDropIndex = jest.fn().mockResolvedValue(true);
      mockCollection = jest.fn(() => ({
        dropIndex: mockDropIndex
      }));

      mockDBCommand = jest.fn().mockResolvedValue(true);
      mockDB = jest.fn(() => ({
        command: mockDBCommand,
        collection: mockCollection
      }));

      mockMongoClient = jest.fn(() => ({
        connect: jest.fn().mockResolvedValue(true),
        db: mockDB
      }));

      jest.mock('mongodb', () => ({
        MongoClient: mockMongoClient
      }));

      require('mongodb');

      mongo = require('../mongo');

      await mongo.connect(logger);

      result = await mongo.dropIndex(
        logger,
        'trailing-trade-logs',
        'trailing-trade-logs-logs-idx'
      );
    });

    it('triggers database.collection', () => {
      expect(mockCollection).toHaveBeenCalledWith('trailing-trade-logs');
    });

    it('triggers collection.dropIndex', () => {
      expect(mockDropIndex).toHaveBeenCalledWith(
        'trailing-trade-logs-logs-idx'
      );
    });

    it('returns expected result', () => {
      expect(result).toStrictEqual(true);
    });
  });

  describe('bulkWrite', () => {
    beforeEach(async () => {
      mockBulkWrite = jest.fn().mockResolvedValue(true);
      mockCollection = jest.fn(() => ({
        bulkWrite: mockBulkWrite
      }));

      mockDBCommand = jest.fn().mockResolvedValue(true);
      mockDB = jest.fn(() => ({
        command: mockDBCommand,
        collection: mockCollection
      }));

      mockMongoClient = jest.fn(() => ({
        connect: jest.fn().mockResolvedValue(true),
        db: mockDB
      }));

      jest.mock('mongodb', () => ({
        MongoClient: mockMongoClient
      }));

      require('mongodb');

      mongo = require('../mongo');

      await mongo.connect(logger);

      result = await mongo.bulkWrite(logger, 'trailing-stop-common', [
        {
          insertOne: {
            document: {
              _id: 4,
              char: 'Dithras',
              class: 'barbarian',
              lvl: 4
            }
          }
        },
        {
          insertOne: {
            document: {
              _id: 5,
              char: 'Taeln',
              class: 'fighter',
              lvl: 3
            }
          }
        },
        {
          updateOne: {
            filter: { char: 'Eldon' },
            update: { $set: { status: 'Critical Injury' } }
          }
        },
        { deleteOne: { filter: { char: 'Brisbane' } } },
        {
          replaceOne: {
            filter: { char: 'Meldane' },
            replacement: { char: 'Tanys', class: 'oracle', lvl: 4 }
          }
        }
      ]);
    });

    it('triggers database.collection', () => {
      expect(mockCollection).toHaveBeenCalledWith('trailing-stop-common');
    });

    it('triggers collection.upsertOne', () => {
      expect(mockBulkWrite).toHaveBeenCalledWith(
        [
          {
            insertOne: {
              document: {
                _id: 4,
                char: 'Dithras',
                class: 'barbarian',
                lvl: 4
              }
            }
          },
          {
            insertOne: {
              document: {
                _id: 5,
                char: 'Taeln',
                class: 'fighter',
                lvl: 3
              }
            }
          },
          {
            updateOne: {
              filter: { char: 'Eldon' },
              update: { $set: { status: 'Critical Injury' } }
            }
          },
          { deleteOne: { filter: { char: 'Brisbane' } } },
          {
            replaceOne: {
              filter: { char: 'Meldane' },
              replacement: { char: 'Tanys', class: 'oracle', lvl: 4 }
            }
          }
        ],
        {
          writeConcern: {
            w: 0,
            j: false
          },
          ordered: false
        }
      );
    });

    it('returns expected result', () => {
      expect(result).toStrictEqual(true);
    });
  });
});
