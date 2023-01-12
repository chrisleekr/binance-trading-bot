const _ = require('lodash');
const { executeTrailingTrade } = require('../index');

const startedJobs = {};
const finishedJobs = {};

/**
 * Initialize queue counters for symbols
 *
 * @param {*} funcLogger
 * @param {*} symbol
 */
const init = async (funcLogger, symbols) => {
  const logger = funcLogger.child({ helper: 'queue' });

  await Promise.all(
    _.map(symbols, async symbol => {
      if (startedJobs[symbol] === undefined) {
        startedJobs[symbol] = 0;
        finishedJobs[symbol] = 0;
      }
    })
  );

  logger.info({ symbols }, `Queue initialized`);
};

/**
 * Prepare the job in queue
 *
 * @param {*} funcLogger
 * @param {*} symbol
 * @param {*} _jobPayload
 */
const prepareJob = async (funcLogger, symbol, _jobPayload) => {
  const logger = funcLogger.child({ helper: 'queue', func: 'prepareJob' });

  // Queue structures existence check
  if (!(symbol in startedJobs)) {
    // Can't queue a job without queue initialized
    logger.error({ symbol }, `No queue created for ${symbol}`);
    return true; // completed
  }

  // Start a new job - wait if previous job is still running
  const pos = (startedJobs[symbol] += 1) - 1;

  if (pos > finishedJobs[symbol]) {
    // Wait until previous job is completed
    logger.info({ symbol }, `Queue ${symbol} job #${pos} waiting`);
    while (pos > finishedJobs[symbol]) {
      // eslint-disable-next-line no-await-in-loop, no-promise-executor-return
      await new Promise(r => setTimeout(r, 10));
    }
  }

  logger.info({ symbol }, `Queue ${symbol} job #${pos} started`);

  return false; // continue
};

/**
 * Execute the job in queue
 *
 * @param {*} funcLogger
 * @param {*} symbol
 * @param {*} jobPayload
 */
const executeJob = async (funcLogger, symbol, jobPayload) => {
  const logger = funcLogger.child({ helper: 'queue', func: 'executeJob' });

  // Preprocess before executeTrailingTrade
  if (jobPayload.preprocessFn) {
    // Return value of preprocessFn decides on calling of executeTrailingTrade
    const result = await jobPayload.preprocessFn();

    if (result === false) {
      logger.info({ symbol }, `Queue ${symbol} job not preprocessed`);
      return false; // continue
    }

    logger.info({ symbol }, `Queue ${symbol} job preprocessed`);
  }

  // Execute the job
  await executeTrailingTrade(
    funcLogger,
    symbol,
    _.get(jobPayload, 'correlationId')
  );

  // Postprocess after executeTrailingTrade
  if (jobPayload.postprocessFn) {
    // postprocessFn
    await jobPayload.postprocessFn();

    logger.info({ symbol }, `Queue ${symbol} job postprocessed`);
  }

  return false; // continue
};

/**
 * Complete the job in queue
 *
 * @param {*} funcLogger
 * @param {*} symbol
 * @param {*} _jobPayload
 */
const completeJob = async (funcLogger, symbol, _jobPayload) => {
  const logger = funcLogger.child({ helper: 'queue', func: 'completeJob' });

  const pos = (finishedJobs[symbol] += 1) - 1;

  if (startedJobs[symbol] === finishedJobs[symbol]) {
    // Last job in the queue finished
    // Reset the counters
    startedJobs[symbol] = (finishedJobs[symbol] -= startedJobs[symbol]) + 0;
  }

  logger.info({ symbol }, `Queue ${symbol} job #${pos} finished`);

  return true; // completed
};

/**
 * Execute queue or preprocessFn
 *
 * @param {*} funcLogger
 * @param {*} symbol
 * @param {*} jobPayload
 */
const execute = async (funcLogger, symbol, jobPayload = {}) => {
  const logger = funcLogger.child({ helper: 'queue' });

  // Use chain of responsibilities pattern to handle the job execution.
  // eslint-disable-next-line no-restricted-syntax
  for (const executeFn of [prepareJob, executeJob, completeJob]) {
    // eslint-disable-next-line no-await-in-loop
    const result = await executeFn(logger, symbol, jobPayload);

    if (result) {
      logger.info({ symbol }, 'Queue job execution completed.');
      break;
    }
  }
};

module.exports = {
  init,
  execute
};
