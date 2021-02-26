const { logger, mongo } = require('./helpers');
const { runCronjob } = require('./server-cronjob');
const { runFrontend } = require('./server-frontend');

(async () => {
  await mongo.connect(logger);

  await runCronjob(logger);

  await runFrontend(logger);
})();
