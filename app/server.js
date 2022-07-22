const { logger: rootLogger, mongo, errorHandler } = require('./helpers');
const { runBinance } = require('./server-binance');
const { runCronjob } = require('./server-cronjob');
const { runFrontend } = require('./server-frontend');

(async () => {
  const logger = rootLogger.child({
    gitHash: process.env.GIT_HASH || 'unspecified'
  });

  errorHandler.run(logger);

  await mongo.connect(logger);

  await runBinance(logger);

  await runCronjob(logger);

  await runFrontend(logger);
})();
