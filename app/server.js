const { logger } = require('./helpers');
const { runCronjob } = require('./server-cronjob');
const { runFrontend } = require('./server-frontend');

(async () => {
  await runCronjob(logger);

  await runFrontend(logger);
})();
