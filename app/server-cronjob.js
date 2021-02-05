const { v4: uuidv4 } = require('uuid');
const config = require('config');
const { CronJob } = require('cron');

const { executeAlive, executeSimpleStopChaser } = require('./jobs');

const runCronjob = serverLogger => {
  const logger = serverLogger.child({ server: 'cronjob' });
  logger.info({ config }, `API ${config.get('mode')} trading started on`);

  const jobInstances = {};

  [
    { jobName: 'alive', executeJob: executeAlive },
    { jobName: 'simpleStopChaser', executeJob: executeSimpleStopChaser }
  ].forEach(job => {
    const { jobName, executeJob } = job;
    if (config.get(`jobs.${jobName}.enabled`)) {
      jobInstances[jobName] = new CronJob(
        config.get(`jobs.${jobName}.cronTime`),
        async () => {
          if (jobInstances[jobName].taskRunning) {
            return;
          }
          jobInstances[jobName].taskRunning = true;

          const moduleLogger = logger.child({ job: jobName, uuid: uuidv4() });
          await executeJob(moduleLogger);

          jobInstances[jobName].taskRunning = false;
        },
        null,
        false,
        config.get('tz')
      );
      jobInstances[jobName].start();
      logger.info(
        { cronTime: config.get(`jobs.${jobName}.cronTime`) },
        `Job ${jobName} has been started.`
      );
    }
  });
};

module.exports = { runCronjob };
