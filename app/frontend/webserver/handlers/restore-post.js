const shell = require('shelljs');
const config = require('config');
const {
  verifyAuthenticated
} = require('../../../cronjob/trailingTradeHelper/common');
const { slack } = require('../../../helpers');

const handleRestorePost = async (funcLogger, app) => {
  const logger = funcLogger.child({
    method: 'POST',
    endpoint: '/restore-post'
  });

  app.route('/restore').post(async (req, res) => {
    if (config.get('demoMode')) {
      return res.send({
        success: false,
        status: 403,
        message: 'You cannot restore database in the demo mode.',
        data: {}
      });
    }

    const authToken = req.header('X-AUTH-TOKEN');

    // Verify authentication
    const isAuthenticated = await verifyAuthenticated(logger, authToken);

    if (isAuthenticated === false) {
      logger.info('Not authenticated');
      return res.send({
        success: false,
        status: 403,
        message: 'Please authenticate first.',
        data: {}
      });
    }

    const { archive } = req.files;

    const filepath = `/tmp/${archive.name}`;
    archive.mv(filepath);

    const result = await new Promise(resolve => {
      shell.exec(
        `${process.cwd()}/scripts/restore.sh ${config.get(
          'mongo.host'
        )} ${config.get('mongo.port')} ${filepath}`,
        (code, stdout, stderr) => {
          resolve({ code, stdout, stderr });
        }
      );
    });

    if (result.code !== 0) {
      slack.sendMessage(`The restore has failed.`, {});

      return res.send({
        success: false,
        status: 500,
        message: 'Restore failed',
        data: result
      });
    }

    return res.send({
      success: true,
      status: 200,
      message: 'Restore success',
      data: result
    });
  });
};

module.exports = { handleRestorePost };
