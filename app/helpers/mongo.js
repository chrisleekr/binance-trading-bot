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
  const result = await collection.insertOne(document);
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
    { upsert: true }
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
  const result = collection.deleteMany(filter);
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
  const result = collection.deleteOne(filter);
  logger.info({ result }, 'Deleted document from MongoDB');

  return result;
};

module.exports = {
  client,
  connect,
  findAll,
  aggregate,
  findOne,
  insertOne,
  upsertOne,
  deleteAll,
  deleteOne
};
