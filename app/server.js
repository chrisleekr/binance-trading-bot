const config = require('config');
const { CronJob } = require('cron');

const { v4: uuidv4 } = require('uuid');
const { logger } = require('./helpers');

const { executeBbands, executeAlive, executeMacdStopChaser } = require('./jobs');

logger.info(`API ${config.get('mode')} trading started on`);

if (config.get('jobs.bbands.enabled')) {
  const jobBbands = new CronJob(
    config.get('jobs.bbands.cronTime'),
    async () => {
      if (jobBbands.taskRunning) {
        return;
      }
      jobBbands.taskRunning = true;

      const moduleLogger = logger.child({ job: 'bbands', uuid: uuidv4() });
      await executeBbands(moduleLogger);

      jobBbands.taskRunning = false;
    },
    null,
    false,
    config.get('tz')
  );
  jobBbands.start();
  logger.info({ cronTime: config.get('jobs.bbands.cronTime') }, 'Bollingers Band job has been started.');
}

if (config.get('jobs.alive.enabled')) {
  const jobAlive = new CronJob(
    config.get('jobs.alive.cronTime'),
    async () => {
      if (jobAlive.taskRunning) {
        return;
      }
      jobAlive.taskRunning = true;

      const moduleLogger = logger.child({ job: 'alive', uuid: uuidv4() });
      await executeAlive(moduleLogger);

      jobAlive.taskRunning = false;
    },
    null,
    false,
    config.get('tz')
  );
  jobAlive.start();
  logger.info({ cronTime: config.get('jobs.alive.cronTime') }, 'Alive job has been started.');
}

if (config.get('jobs.macdStopChaser.enabled')) {
  const jobMacdStopChaser = new CronJob(
    config.get('jobs.macdStopChaser.cronTime'),
    async () => {
      if (jobMacdStopChaser.taskRunning) {
        return;
      }
      jobMacdStopChaser.taskRunning = true;

      const moduleLogger = logger.child({ job: 'macdStopChaser', uuid: uuidv4() });
      await executeMacdStopChaser(moduleLogger);

      jobMacdStopChaser.taskRunning = false;
    },
    null,
    false,
    config.get('tz')
  );
  jobMacdStopChaser.start();
  logger.info({ cronTime: config.get('jobs.macdStopChaser.cronTime') }, 'MACD Stop Chaser job has been started.');
}
