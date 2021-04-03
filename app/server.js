const { logger, mongo } = require('./helpers');
const { runBinance } = require('./server-binance');
const { runCronjob } = require('./server-cronjob');
const { runFrontend } = require('./server-frontend');

(async () => {
  await mongo.connect(logger);

  await runBinance(logger);

  await runCronjob(logger);

  await runFrontend(logger);
})();
