const moment = require('moment-timezone');
const fs = require('fs');
const path = require('path');
const { sep: directorySeparator } = require('path');
const {
  verifyAuthenticated
} = require('../../../cronjob/trailingTradeHelper/common');

const { mongo } = require('../../../helpers');

const keepLastLogs = (fileFolder, numberOfFilesToKeep) => {
  const recentFiles = fs
    .readdirSync(fileFolder)
    .filter(file => fs.lstatSync(path.join(fileFolder, file)).isFile())
    .map(file => ({
      file,
      mtime: fs.lstatSync(path.join(fileFolder, file)).mtime
    }))
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  if (recentFiles.length < numberOfFilesToKeep) {
    return;
  }
  const deleteFiles = recentFiles.slice(numberOfFilesToKeep - 1);

  deleteFiles.forEach(f =>
    fs.unlinkSync(`${fileFolder}${directorySeparator}${f.file}`)
  );
};

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

    const fileName = `${symbol}-${moment().format('YYYY-MM-DD-HH-MM-ss')}.json`;
    const fileFolder = path.join(global.appRoot, '/../public/data/logs');

    if (!fs.existsSync(fileFolder)) {
      fs.mkdirSync(fileFolder);
    }
    keepLastLogs(fileFolder, 10);

    const match = {};
    const group = {};

    match.symbol = symbol;
    // eslint-disable-next-line no-underscore-dangle
    group._id = '$symbol';
    group.symbol = { $first: '$symbol' };

    const rows = await mongo.findAll(logger, 'trailing-trade-logs', match, {
      sort: { loggedAt: -1 }
    });

    const filePath = `${fileFolder}${directorySeparator}${fileName}`;
    fs.writeFileSync(filePath, JSON.stringify(rows));

    return res.send({
      success: true,
      status: 200,
      message: 'Exported log file',
      data: {
        fileName
      }
    });
  });
};

module.exports = { handleGridTradeLogsExport };
