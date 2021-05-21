const { v4: uuidv4 } = require('uuid');
const config = require('config');
const { CronJob } = require('cron');

const {
  executeAlive,
  executeTrailingTrade,
  executeTrailingTradeIndicator
} = require('./cronjob');

const fulfillWithTimeLimit = async (logger, timeLimit, task, failureValue) => {
  let timeout;
  const timeoutPromise = new Promise(resolve => {
    timeout = setTimeout(() => {
      logger.error(
        { tag: 'job-timeout' },
        `Failed to run the job within ${timeLimit}ms.`
      );

      resolve(failureValue);
    }, timeLimit);
  });

  const response = await Promise.race([task, timeoutPromise]);

  /* istanbul ignore next */
  if (timeout) {
    // the code works without this but let's be safe and clean up the timeout.
    clearTimeout(timeout);
  }
  return response;
};

const runCronjob = async serverLogger => {
  const logger = serverLogger.child({ server: 'cronjob' });
  logger.info({ config }, `API ${config.get('mode')} trading started on`);

  const jobInstances = {};

  // Execute jobs
  [
    { jobName: 'alive', executeJob: executeAlive },
    { jobName: 'trailingTrade', executeJob: executeTrailingTrade },
    {
      jobName: 'trailingTradeIndicator',
      executeJob: executeTrailingTradeIndicator
    }
  ].forEach(job => {
    const { jobName, executeJob } = job;
    if (config.get(`jobs.${jobName}.enabled`)) {
      jobInstances[jobName] = new CronJob(
        config.get(`jobs.${jobName}.cronTime`),
        async () => {
          if (jobInstances[jobName].taskRunning) {
            logger.info(
              { debug: true, jobName },
              'Task is running, skip this tick'
            );
            return;
          }
          jobInstances[jobName].taskRunning = true;

          const moduleLogger = logger.child({ job: jobName, uuid: uuidv4() });

          // Make sure the job running within 20 seconds.
          // If longer than 20 seconds, something went wrong.
          await fulfillWithTimeLimit(
            moduleLogger,
            20000,
            executeJob(moduleLogger),
            null
          );

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
