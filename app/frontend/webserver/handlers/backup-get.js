const shell = require('shelljs');
const config = require('config');
const moment = require('moment');
const {
  verifyAuthenticated
} = require('../../../cronjob/trailingTradeHelper/common');
const { slack } = require('../../../helpers');

const handleBackupGet = async (funcLogger, app) => {
  const logger = funcLogger.child({
    method: 'GET',
    endpoint: '/backup-get'
  });

  app.route('/backup').get(async (req, res) => {
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

    const filename = `binance-bot-${moment().format(
      'YYYY-MM-DD-HH-mm-ss'
    )}.archive`;
    const filepath = `/tmp/${filename}`;

    const result = await new Promise(resolve => {
      shell.exec(
        `${process.cwd()}/scripts/backup.sh ${config.get(
          'mongo.host'
        )} ${config.get('mongo.port')} ${config.get(
          'mongo.database'
        )} ${filepath}`,
        (code, stdout, stderr) => {
          resolve({ code, stdout, stderr });
        }
      );
    });

    if (result.code !== 0) {
      slack.sendMessage(
        `The backup has failed.\n\`\`\`${JSON.stringify(result)}\`\`\``,
        {}
      );

      return res.send({
        success: false,
        status: 500,
        message: 'Backup failed',
        data: result
      });
    }

    return res.download(filepath, filename);
  });
};

module.exports = { handleBackupGet };
