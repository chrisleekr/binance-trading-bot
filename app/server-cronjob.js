const { v4: uuidv4 } = require('uuid');
const config = require('config');
const { CronJob } = require('cron');
const { maskConfig } = require('./cronjob/trailingTradeHelper/util');

const {
  executeAlive,
  executeTrailingTradeIndicator,
  executeTradingView
} = require('./cronjob');

const runCronjob = async serverLogger => {
  const logger = serverLogger.child({ server: 'cronjob' });
  logger.info(
    { config: maskConfig(config) },
    `API ${config.get('mode')} trading started on`
  );

  const jobInstances = {};

  // Execute jobs
  [
    { jobName: 'alive', executeJob: executeAlive },
    {
      jobName: 'trailingTradeIndicator',
      executeJob: executeTrailingTradeIndicator
    },
    {
      jobName: 'tradingView',
      executeJob: executeTradingView
    }
  ].forEach(job => {
    const { jobName, executeJob } = job;
    if (config.get(`jobs.${jobName}.enabled`)) {
      jobInstances[jobName] = new CronJob(
        config.get(`jobs.${jobName}.cronTime`),
        async () => {
          if (jobInstances[jobName].taskRunning) {
            logger.info({ jobName }, 'Task is running, skip this tick');
            return;
          }
          jobInstances[jobName].taskRunning = true;

          const moduleLogger = logger.child({ job: jobName, uuid: uuidv4() });

          executeJob(moduleLogger);

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
