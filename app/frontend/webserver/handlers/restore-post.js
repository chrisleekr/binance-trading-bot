const { execFile } = require('child_process');
const config = require('config');
const path = require('path');
const crypto = require('crypto');
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

    // Create a random name for the archive file
    const randomName = crypto.randomBytes(16).toString('hex');
    const filepath = path.join('/tmp', `${randomName}`);
    await archive.mv(filepath);

    // Execute the restore script
    const result = await new Promise(resolve => {
      execFile(
        `${process.cwd()}/scripts/restore.sh`,
        [config.get('mongo.host'), config.get('mongo.port'), filepath],
        (error, stdout, stderr) => {
          if (error) {
            resolve({ code: 1, stdout, stderr, error });
            return;
          }
          resolve({ code: 0, stdout, stderr });
        }
      );
    });

    if (result.code !== 0) {
      slack.sendMessage(`The restore has failed.`, { symbol: 'global' });

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
