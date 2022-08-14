const config = require('config');
const { slack } = require('./helpers');
const { getAPILimit } = require('./cronjob/trailingTradeHelper/common');

const runErrorHandler = logger => {
  // This will catch the unhandled rejected Promise
  process.on('unhandledRejection', err => {
    // we will throw it to handle it in the exception
    throw err;
  });

  // This will catch any unexpected errors that we don't handled them
  // and report them to slack
  // https://nodejs.org/api/process.html#process_event_uncaughtexception
  process.on('uncaughtException', async err => {
    logger.error({ err });
    const githubIssuesLink =
      'https://github.com/chrisleekr/binance-trading-bot/issues/new' +
      '?assignees=&labels=bug&template=bug_report.md&title=';
    slack.sendMessage(
      `Uncaught Exception:\n` +
        `If you see this, kindly report it to: ${githubIssuesLink}\n` +
        `Code: ${err.code}\n` +
        `Message:\`\`\`${err.message}\`\`\`\n` +
        `${
          config.get('featureToggle.notifyDebug')
            ? `Stack:\`\`\`${err.stack}\`\`\`\n`
            : ''
        }`,
      { apiLimit: getAPILimit(logger) }
    );
  });
};

const handleError = (logger, job, err) => {
  // For the redlock fail
  if (err.message.includes('redlock')) {
    // Simply ignore
    return;
  }

  logger.error(
    { err, errorCode: err.code, debug: true, saveLog: true },
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
      `Execution failed:\n` +
        `Job: ${job}\n` +
        `Code: ${err.code}\n` +
        `Message:\`\`\`${err.message}\`\`\`\n` +
        `${
          config.get('featureToggle.notifyDebug')
            ? `Stack:\`\`\`${err.stack}\`\`\`\n`
            : ''
        }`,
      { apiLimit: getAPILimit(logger) }
    );
  }
};

const errorHandlerWrapper = async (logger, job, callback) => {
  try {
    await callback();
  } catch (err) {
    handleError(logger, job, err);
  }
};

module.exports = { runErrorHandler, errorHandlerWrapper, handleError };
