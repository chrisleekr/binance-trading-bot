const mongodb = jest.createMockFromModule('mongodb');

const mongoClient = {
  connect: jest.fn(),
  db: jest.fn(() => ({
    command: jest.fn()
  })),
  collection: jest.fn(() => ({
    findOne: jest.fn(),
    insertOne: jest.fn(),
    updateOne: jest.fn(),
    deleteOne: jest.fn()
  }))
};

mongodb.MongoClient = jest.fn(() => mongoClient);

module.exports = mongodb;
