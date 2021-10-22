const { v4: uuidv4 } = require('uuid');
const fs = require('fs');

const {
  verifyAuthenticated
} = require('../../../cronjob/trailingTradeHelper/common');

const { mongo } = require('../../../helpers');

const handleGridTradeLogsExport = async (funcLogger, app) => {
  const logger = funcLogger.child({
    endpoint: '/grid-trade-logs-export'
  });

  app.route('/grid-trade-logs-export').post(async (req, res) => {
    const { authToken, symbol } = req.body;

    logger.info('Export grid trade logs');

    const isAuthenticated = await verifyAuthenticated(logger, authToken);

    if (isAuthenticated === false) {
      logger.info('Not authenticated');
      return res.send({
        success: false,
        status: 403,
        message: 'Please authenticate first.',
        data: {
          rows: []
        }
      });
    }

    const match = {};
    const group = {};

    match.symbol = symbol;
    // eslint-disable-next-line no-underscore-dangle
    group._id = '$symbol';
    group.symbol = { $first: '$symbol' };

    const rows = await mongo.findAll(logger, 'trailing-trade-logs', match, {
      sort: { loggedAt: -1 }
    });
    const filePath = `/tmp/${uuidv4()}.json`;
    fs.writeFileSync(filePath, JSON.stringify(rows));

    return res.download(filePath);
  });
};

module.exports = { handleGridTradeLogsExport };
