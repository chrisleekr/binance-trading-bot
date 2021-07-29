/* eslint-disable no-useless-catch */
/* eslint-disable no-console */
/* eslint-disable class-methods-use-this */
const config = require('config');
const { MongoClient } = require('mongodb');

const clusterUrl = `${config.get('mongo.host')}:${config.get('mongo.port')}`;
const url = `mongodb://${clusterUrl}/`;

class MongoDbStore {
  async load(fn) {
    let client = null;
    let data = null;
    try {
      client = await MongoClient.connect(url, {
        useNewUrlParser: true,
        useUnifiedTopology: true
      });
      const db = client.db(config.get('mongo.database'));
      data = await db.collection('trailing-trade-migrations').find().toArray();
      if (data.length !== 1) {
        console.log(
          'Cannot read migrations from database. If this is the first time you run migrations, then this is normal.'
        );
        return fn(null, {});
      }
    } catch (err) {
      throw err;
    } finally {
      client.close();
    }
    return fn(null, data[0]);
  }

  async save(set, fn) {
    let client = null;
    let result = null;
    try {
      client = await MongoClient.connect(url, {
        useNewUrlParser: true,
        useUnifiedTopology: true
      });
      const db = client.db(config.get('mongo.database'));
      result = await db.collection('trailing-trade-migrations').updateMany(
        {},
        {
          $set: {
            lastRun: set.lastRun
          },
          $push: {
            migrations: { $each: set.migrations }
          }
        },
        { upsert: true }
      );
    } catch (err) {
      throw err;
    } finally {
      client.close();
    }

    return fn(null, result);
  }
}

module.exports = MongoDbStore;
