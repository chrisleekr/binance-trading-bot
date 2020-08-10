const config = require('config');
const { CronJob } = require('cron');
const { v4: uuidv4 } = require('uuid');
const { logger } = require('./helpers');

const { executeBbands, executeAlive } = require('./jobs');

logger.info(`API ${config.get('mode')} trading started on`);

if (config.get('jobs.bbands.enabled')) {
  const jobBbands = new CronJob(
    config.get('jobs.bbands.cronTime'),
    async () => {
      const moduleLogger = logger.child({ job: 'bbands', uuid: uuidv4() });
      await executeBbands(moduleLogger);
    },
    null,
    true,
    config.get('tz')
  );
  jobBbands.start();
  logger.info({ cronTime: config.get('jobs.bbands.cronTime') }, 'Bollingers Band job has been started.');
}

if (config.get('jobs.alive.enabled')) {
  const jobAlive = new CronJob(
    config.get('jobs.alive.cronTime'),
    async () => {
      const moduleLogger = logger.child({ job: 'alive', uuid: uuidv4() });
      await executeAlive(moduleLogger);
    },
    null,
    false,
    config.get('tz')
  );
  jobAlive.start();
  logger.info({ cronTime: config.get('jobs.alive.cronTime') }, 'Alive job has been started.');
}
