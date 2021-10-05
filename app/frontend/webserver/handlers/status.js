const requestIp = require('request-ip');

const handleStatus = async (funcLogger, app) => {
  const logger = funcLogger.child({ endpoint: '/status' });

  app.route('/status').get(async (req, res) => {
    const clientIp = requestIp.getClientIp(req);

    logger.info(
      {
        clientIp
      },
      'handle status monitoring endpoint'
    );

    return res.send({
      success: true,
      status: 200,
      message: 'OK'
    });
  });
};

module.exports = { handleStatus };
