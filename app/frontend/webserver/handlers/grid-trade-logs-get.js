const {
  verifyAuthenticated
} = require('../../../cronjob/trailingTradeHelper/common');

const { mongo } = require('../../../helpers');

const handleGridTradeLogsGet = async (funcLogger, app) => {
  const logger = funcLogger.child({
    endpoint: '/grid-trade-logs-get'
  });

  app.route('/grid-trade-logs-get').post(async (req, res) => {
    const { authToken, symbol, page: rawPage, limit: rawLimit } = req.body;

    // Verify authentication
    const page = rawPage || 1;
    const limit = rawLimit || 5;

    logger.info({ page, limit }, 'Grid Trade Logs');

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

    const match = {};
    const group = {};
    const initialValue = {};

    match.symbol = symbol;
    // eslint-disable-next-line no-underscore-dangle
    group._id = '$symbol';
    group.symbol = { $first: '$symbol' };
    initialValue.symbol = symbol;

    const rows = await mongo.findAll(logger, 'trailing-trade-logs', match, {
      sort: { loggedAt: -1 },
      skip: (page - 1) * limit,
      limit
    });

    const stats = (
      await mongo.aggregate(logger, 'trailing-trade-logs', [
        {
          $match: match
        },
        {
          $group: {
            ...group,
            rows: { $sum: 1 }
          }
        },
        {
          $project: {
            rows: 1
          }
        }
      ])
    )[0] || {
      ...initialValue,
      rows: 0
    };

    return res.send({
      success: true,
      status: 200,
      message: 'Retrieved grid-trade-logs-get',
      data: {
        rows,
        stats
      }
    });
  });
};

module.exports = { handleGridTradeLogsGet };
