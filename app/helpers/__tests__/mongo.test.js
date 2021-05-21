/* eslint-disable global-require */
const logger = require('../logger');

describe('mongo.js', () => {
  let mockDB;
  let mockDBCommand;
  let mockMongoClient;

  let mongo;

  let result;
  let mockCollection;
  let mockFindOne;
  let mockInsertOne;
  let mockUpdateOne;
  let mockDeleteMany;
  let mockDeleteOne;

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
          'mongodb://binance-mongo:27017/?poolSize=20&retryWrites=true&writeConcern=majority',
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
      expect(mockInsertOne).toHaveBeenCalledWith({
        key: 'configuration',
        my: 'value'
      });
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
          upsert: true
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
      expect(mockDeleteMany).toHaveBeenCalledWith({
        key: 'configuration'
      });
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
      expect(mockDeleteOne).toHaveBeenCalledWith({
        key: 'configuration'
      });
    });

    it('returns expected result', () => {
      expect(result).toStrictEqual(true);
    });
  });
});
