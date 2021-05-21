const config = require('config');
const { MongoClient } = require('mongodb');

const clusterUrl = `${config.get('mongo.host')}:${config.get('mongo.port')}`;

const uri = `mongodb://${clusterUrl}/?poolSize=20&retryWrites=true&writeConcern=majority`;

const client = new MongoClient(uri, {
  useNewUrlParser: true,
  useUnifiedTopology: true
});

let database;

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

const findOne = async (funcLogger, collectionName, query) => {
  const logger = funcLogger.child({ helper: 'mongo', funcName: 'findOne' });

  const collection = database.collection(collectionName);

  logger.info({ collectionName, query }, 'Finding document from MongoDB');
  const result = await collection.findOne(query);
  logger.info({ result }, 'Found document from MongoDB');

  return result;
};

const insertOne = async (funcLogger, collectionName, document) => {
  const logger = funcLogger.child({ helper: 'mongo', funcName: 'insertOne' });

  const collection = database.collection(collectionName);

  logger.info({ collectionName, document }, 'Inserting document to MongoDB');
  const result = await collection.insertOne(document);
  logger.info({ result }, 'Inserted document to MongoDB');

  return result;
};

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

const deleteAll = async (funcLogger, collectionName, filter) => {
  const logger = funcLogger.child({ helper: 'mongo', funcName: 'deleteAll' });

  logger.info({ collectionName, filter }, 'Deleting documents from MongoDB');
  const collection = database.collection(collectionName);
  const result = collection.deleteMany(filter);
  logger.info({ result }, 'Deleted documents from MongoDB');

  return result;
};

const deleteOne = async (funcLogger, collectionName, filter) => {
  const logger = funcLogger.child({ helper: 'mongo', funcName: 'deleteOne' });

  logger.info({ collectionName, filter }, 'Deleting document from MongoDB');
  const collection = database.collection(collectionName);
  const result = collection.deleteOne(filter);
  logger.info({ result }, 'Deleted document from MongoDB');

  return result;
};

module.exports = {
  connect,
  findOne,
  insertOne,
  upsertOne,
  deleteAll,
  deleteOne
};
