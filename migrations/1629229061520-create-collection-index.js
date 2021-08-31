const path = require('path');
const { logger: rootLogger, mongo } = require('../app/helpers');

module.exports.up = async () => {
  const logger = rootLogger.child({
    gitHash: process.env.GIT_HASH || 'unspecified',
    migration: path.basename(__filename)
  });

  const database = await mongo.connect(logger);

  logger.info('Start migration');

  let result;

  await Promise.all(
    [
      'trailing-trade-common',
      'trailing-trade-symbols',
      'trailing-trade-grid-trade'
    ].map(async collectionName => {
      const collection = database.collection(collectionName);
      try {
        result = await collection.dropIndex(`${collectionName}-key-idx`);
      } catch (e) {
        logger.warn(`Index '${collectionName}-key-idx' is not found. It's ok.`);
      }

      result = await collection.createIndex(
        { key: 1 },
        { name: `${collectionName}-key-idx` }
      );
      logger.info(
        { collectionName, result },
        'Created collection index for key fields'
      );
    })
  );

  const collectionName = 'trailing-trade-grid-trade-archive';
  const gridTradeArchiveCollection = database.collection(collectionName);
  try {
    result = await gridTradeArchiveCollection.dropIndex(
      `${collectionName}-quote-asset-idx`
    );
  } catch (e) {
    logger.warn(
      `Index '${collectionName}-quote-asset-idx' is not found. It's ok.`
    );
  }

  result = await gridTradeArchiveCollection.createIndex(
    { quoteAsset: 1, archivedAt: 1 },
    {
      name: `${collectionName}-quote-asset-idx`,
      background: true
    }
  );

  try {
    result = await gridTradeArchiveCollection.dropIndex(
      `${collectionName}-symbol-idx`
    );
  } catch (e) {
    logger.warn(`Index '${collectionName}-symbol-idx' is not found. It's ok.`);
  }

  result = await gridTradeArchiveCollection.createIndex(
    { symbol: 1, archivedAt: 1 },
    {
      name: `${collectionName}-symbol-idx`,
      background: true
    }
  );

  try {
    result = await gridTradeArchiveCollection.dropIndex(
      `${collectionName}-idx`
    );
  } catch (e) {
    logger.warn(`Index '${collectionName}-idx' is not found. It's ok.`);
  }

  result = await gridTradeArchiveCollection.createIndex(
    {
      symbol: 1,
      quoteAsset: 1,
      totalBuyQuoteQty: 1,
      totalSellQuoteQty: 1,
      buyGridTradeQuoteQty: 1,
      buyManualQuoteQty: 1,
      sellGridTradeQuoteQty: 1,
      sellManualQuoteQty: 1,
      stopLossQuoteQty: 1,
      profit: 1,
      profitPercentage: 1
    },
    {
      name: `${collectionName}-idx`,
      background: true
    }
  );
  logger.info(
    { collectionName },
    'Created collection index for archive table.'
  );

  logger.info('Finish migration');
};

module.exports.down = next => {
  next();
};
