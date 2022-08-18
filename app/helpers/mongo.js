const config = require('config');
const { MongoClient } = require('mongodb');

const clusterUrl = `${config.get('mongo.host')}:${config.get('mongo.port')}`;

const uri = `mongodb://${clusterUrl}/?retryWrites=true&writeConcern=majority`;

const client = new MongoClient(uri, {
  useNewUrlParser: true,
  useUnifiedTopology: true
});

let database;

/**
 * Connect to MongoDB
 *
 * @param {*} funcLogger
 */
const connect = async funcLogger => {
  const logger = funcLogger.child({ helper: 'mongo' });
  logger.info({ uri }, 'Connecting mongodb');
  try {
    await client.connect();

    // Establish and verify connection
    await client.db('admin').command({ ping: 1 });
    database = client.db(config.get('mongo.database'));
    logger.info('Connected successfully to mongodb');
  } catch (e) {
    logger.error({ e }, 'Error on connecting to mongodb');
    process.exit(1);
  }

  return database;
};

/**
 * Count
 *
 * @param {*} funcLogger
 * @param {*} collectionName
 * @param {*} query
 *
 * @returns
 */
const count = async (funcLogger, collectionName, query) => {
  const logger = funcLogger.child({ helper: 'mongo', funcName: 'count' });

  const collection = database.collection(collectionName);

  logger.info({ query }, 'Finding document from MongoDB');

  const result = await collection.count(query);

  logger.info({ result }, 'Found documents from MongoDB');

  return result;
};

/**
 * Find all
 *
 * @param {*} funcLogger
 * @param {*} collectionName
 * @param {*} query
 * @param {*} params
 *
 * @returns
 */
const findAll = async (funcLogger, collectionName, query, params = {}) => {
  const logger = funcLogger.child({ helper: 'mongo', funcName: 'findAll' });

  const collection = database.collection(collectionName);

  logger.info({ query, params }, 'Finding document from MongoDB');

  const result = await collection.find(query, params).toArray();

  logger.info({ result }, 'Found documents from MongoDB');

  return result;
};

/**
 * Agreegate result with pagination
 *
 * @param {*} funcLogger
 * @param {*} collectionName
 * @param {*} query
 * @returns
 */
const aggregate = async (funcLogger, collectionName, query) => {
  const logger = funcLogger.child({ helper: 'mongo', funcName: 'aggregate' });

  const collection = database.collection(collectionName);

  logger.info({ query }, 'Finding document from MongoDB');

  const result = await collection.aggregate(query).toArray();

  logger.info({ result }, 'Found documents from MongoDB');

  return result;
};

/**
 * Find one row
 *
 * @param {*} funcLogger
 * @param {*} collectionName
 * @param {*} query
 *
 * @returns
 */
const findOne = async (funcLogger, collectionName, query) => {
  const logger = funcLogger.child({ helper: 'mongo', funcName: 'findOne' });

  const collection = database.collection(collectionName);

  logger.info({ collectionName, query }, 'Finding document from MongoDB');
  const result = await collection.findOne(query);
  logger.info({ result }, 'Found document from MongoDB');

  return result;
};

/**
 * Insert one row
 *
 * @param {*} funcLogger
 * @param {*} collectionName
 * @param {*} document
 *
 * @returns
 */
const insertOne = async (funcLogger, collectionName, document) => {
  const logger = funcLogger.child({ helper: 'mongo', funcName: 'insertOne' });

  const collection = database.collection(collectionName);

  logger.info({ collectionName, document }, 'Inserting document to MongoDB');
  const result = await collection.insertOne(document, {
    // https://docs.mongodb.com/v3.2/reference/write-concern/
    writeConcern: {
      w: 0,
      j: false
    }
  });
  logger.info({ result }, 'Inserted document to MongoDB');

  return result;
};

/**
 * Upsert one row
 *
 * @param {*} funcLogger
 * @param {*} collectionName
 * @param {*} filter
 * @param {*} document
 *
 * @returns
 */
const upsertOne = async (funcLogger, collectionName, filter, document) => {
  const logger = funcLogger.child({ helper: 'mongo', funcName: 'upsertOne' });

  const collection = database.collection(collectionName);

  logger.info(
    { collectionName, filter, document },
    'Upserting document to MongoDB'
  );
  const result = await collection.updateOne(
    filter,
    { $set: document },
    {
      upsert: true,
      // https://docs.mongodb.com/v3.2/reference/write-concern/
      writeConcern: {
        w: 0,
        j: false
      }
    }
  );
  logger.info({ result }, 'Upserted document to MongoDB');

  return result;
};

/**
 * Delete all rows
 *
 * @param {*} funcLogger
 * @param {*} collectionName
 * @param {*} filter
 *
 * @returns
 */
const deleteAll = async (funcLogger, collectionName, filter) => {
  const logger = funcLogger.child({ helper: 'mongo', funcName: 'deleteAll' });

  logger.info({ collectionName, filter }, 'Deleting documents from MongoDB');
  const collection = database.collection(collectionName);
  const result = collection.deleteMany(filter, {
    // https://docs.mongodb.com/v3.2/reference/write-concern/
    writeConcern: {
      w: 0,
      j: false
    }
  });
  logger.info({ result }, 'Deleted documents from MongoDB');

  return result;
};

/**
 * Delete one row
 *
 * @param {*} funcLogger
 * @param {*} collectionName
 * @param {*} filter
 *
 * @returns
 */
const deleteOne = async (funcLogger, collectionName, filter) => {
  const logger = funcLogger.child({ helper: 'mongo', funcName: 'deleteOne' });

  logger.info({ collectionName, filter }, 'Deleting document from MongoDB');
  const collection = database.collection(collectionName);
  const result = collection.deleteOne(filter, {
    // https://docs.mongodb.com/v3.2/reference/write-concern/
    writeConcern: {
      w: 0,
      j: false
    }
  });
  logger.info({ result }, 'Deleted document from MongoDB');

  return result;
};

/**
 * Create new index
 *
 * @param {*} funcLogger
 * @param {*} collectionName
 * @param {*} keys
 * @param {*} options
 * @returns
 */
const createIndex = async (funcLogger, collectionName, keys, options) => {
  const logger = funcLogger.child({ helper: 'mongo', funcName: 'createIndex' });

  logger.info({ collectionName, keys, options }, 'Creating index from MongoDB');
  const collection = database.collection(collectionName);
  const result = collection.createIndex(keys, options);
  logger.info({ result }, 'Created index from MongoDB');

  return result;
};

/**
 * Drop index
 *
 * @param {*} funcLogger
 * @param {*} collectionName
 * @param {*} indexName
 * @returns
 */
const dropIndex = async (funcLogger, collectionName, indexName) => {
  const logger = funcLogger.child({ helper: 'mongo', funcName: 'dropIndex' });

  logger.info({ collectionName, indexName }, 'Dropping index from MongoDB');
  const collection = database.collection(collectionName);
  const result = collection.dropIndex(indexName);
  logger.info({ result }, 'Dropped index from MongoDB');

  return result;
};

/**
 * Bulk write data
 *
 * @param {*} funcLogger
 * @param {*} collectionName
 * @param {*} operations
 *
 * @returns
 */
const bulkWrite = async (funcLogger, collectionName, operations) => {
  const logger = funcLogger.child({ helper: 'mongo', funcName: 'bulkWrite' });

  const collection = database.collection(collectionName);

  logger.info(
    { collectionName, operations },
    'Bulk writing documents to MongoDB'
  );
  const result = await collection.bulkWrite(operations, {
    writeConcern: {
      w: 0,
      j: false
    },
    ordered: false
  });
  logger.info({ result }, 'Finished bulk writing documents to MongoDB');

  return result;
};

module.exports = {
  client,
  connect,
  count,
  findAll,
  aggregate,
  findOne,
  insertOne,
  upsertOne,
  deleteAll,
  deleteOne,
  createIndex,
  dropIndex,
  bulkWrite
};
