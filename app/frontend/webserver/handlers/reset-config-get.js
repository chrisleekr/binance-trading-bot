const {
  verifyAuthenticated
} = require('../../../cronjob/trailingTradeHelper/common');
const {
  resetGlobalConfiguration
} = require('../../../cronjob/trailingTradeHelper/configuration');

const handleResetConfigGet = async (funcLogger, app) => {
  const logger = funcLogger.child({
    method: 'GET',
    endpoint: '/reset-config-get'
  });

  app.route('/reset-config').get(async (req, res) => {
    const authToken = req.header('X-AUTH-TOKEN');

    // Verify authentication
    const isAuthenticated = await verifyAuthenticated(logger, authToken);

    if (isAuthenticated === false) {
      logger.info('Not authenticated');
      return res.sendStatus(403);
    }

    await resetGlobalConfiguration(logger);

    return res.sendStatus(200);
  });
};

module.exports = { handleResetConfigGet };
