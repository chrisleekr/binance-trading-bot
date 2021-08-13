const {
  verifyAuthenticated
} = require('../../../cronjob/trailingTradeHelper/common');

const { mongo } = require('../../../helpers');

const handleGridTradeArchiveDelete = async (funcLogger, app) => {
  const logger = funcLogger.child({
    endpoint: '/grid-trade-archive-delete'
  });
  app.route('/grid-trade-archive-delete').post(async (req, res) => {
    const { authToken, query } = req.body;

    // Verify authentication
    logger.info({ query }, 'Delete Grid Trade Archive');

    const isAuthenticated = await verifyAuthenticated(logger, authToken);
    if (isAuthenticated === false) {
      logger.info('Not authenticated');
      return res.send({
        success: false,
        status: 403,
        message: 'Please authenticate first.',
        data: {
          rows: [],
          stats: {}
        }
      });
    }

    // Delete from database
    await mongo.deleteAll(logger, 'trailing-trade-grid-trade-archive', query);

    return res.send({
      success: true,
      status: 200,
      message: 'Retrieved grid-trade-archive-delete',
      data: {}
    });
  });
};

module.exports = { handleGridTradeArchiveDelete };
