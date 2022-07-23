const moment = require('moment');
const config = require('config');
const { slack } = require('./helpers');
const { getAPILimit } = require('./cronjob/trailingTradeHelper/common');

const runErrorHandler = logger => {
  // This will catch the rejected Promise
  process.on('unhandledRejection', err => {
    // we will throw it to handle it in the exception
    throw err;
  });

  process.on('uncaughtException', err => {
    // For the redlock fail
    if (err.message.includes('redlock')) {
      // Simply ignore
      return;
    }

    logger.error(
      { err, errorCode: err.code, debug: true },
      `⚠ Execution failed.`
    );
    if (
      err.code === -1001 ||
      err.code === -1021 || // Timestamp for this request is outside the recvWindow
      err.code === 'ECONNRESET' ||
      err.code === 'ECONNREFUSED'
    ) {
      // Let's silent for internal server error or assumed temporary errors
    } else {
      slack.sendMessage(
        `Execution failed (${moment().format('HH:mm:ss.SSS')})\n` +
          `Job: Trailing Trade\n` +
          `Code: ${err.code}\n` +
          `Message:\`\`\`${err.message}\`\`\`\n` +
          `${
            config.get('featureToggle.notifyDebug')
              ? `Stack:\`\`\`${err.stack}\`\`\`\n`
              : ''
          }` +
          `- Current API Usage: ${getAPILimit(logger)}`
      );
    }
  });
};

module.exports = { runErrorHandler };
