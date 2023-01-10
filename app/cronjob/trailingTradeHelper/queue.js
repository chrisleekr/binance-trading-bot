const _ = require('lodash');
const { executeTrailingTrade } = require('../index');

let startedJobs = {};
let finishedJobs = {};

/**
 * Initialize queue counters for symbols
 *
 * @param {*} funcLogger
 * @param {*} symbol
 */
const init = async (funcLogger, symbols) => {
  const logger = funcLogger.child({ helper: 'queue' });

  startedJobs = {};
  finishedJobs = {};

  await Promise.all(
    _.map(symbols, async symbol => {
      startedJobs[symbol] = 0;
      finishedJobs[symbol] = 0;
    })
  );

  logger.info({ symbols }, `Queue initialized`);
};

/**
 * Process for symbol queue
 *
 * @param {*} funcLogger
 * @param {*} symbol
 * @param {*} modifiers
 * @param {*} jobData
 *
 * @returns
 */
const executeQueue = async (funcLogger, symbol, modifiers, jobData) => {
  // When the queue parameter is not defined, then do not process.
  if (!modifiers.queue) {
    // Return false to run the next function.
    return false;
  }

  const logger = funcLogger.child({ helper: 'queue', func: 'executeQueue' });

  if (!(symbol in startedJobs)) {
    logger.error({ symbol }, `No queue created for ${symbol}`);
    // Return true to make sure it does not process next function.
    return true;
  }

  // Start
  const startPos = (startedJobs[symbol] += 1) - 1;

  if (startPos > finishedJobs[symbol]) {
    logger.info({ symbol }, `Queue ${symbol} job #${startPos} waiting`);
    while (startPos > finishedJobs[symbol]) {
      // eslint-disable-next-line no-await-in-loop, no-promise-executor-return
      await new Promise(r => setTimeout(r, 10));
    }
  }

  logger.info({ symbol }, `Queue ${symbol} job #${startPos} started`);

  await executeTrailingTrade(
    funcLogger,
    symbol,
    _.get(jobData, 'correlationId')
  );

  const finishPos = (finishedJobs[symbol] += 1) - 1;

  if (startedJobs[symbol] === finishedJobs[symbol]) {
    // Last job in the queue finished
    // Reset the counters
    startedJobs[symbol] = (finishedJobs[symbol] -= startedJobs[symbol]) + 0;
  }

  logger.info({ symbol }, `Queue ${symbol} job #${finishPos} finished`);
  return true;
};

/**
 * Execute for preprocess function
 *
 * @param {*} funcLogger
 * @param {*} symbol
 * @param {*} modifiers
 * @param {*} jobData
 *
 * @returns
 */
const executePreprocessFn = async (funcLogger, symbol, modifiers, jobData) => {
  // When the preprocessFn parameter is not defined, then do not process.
  if (!modifiers.preprocessFn) {
    // Return false to run the next function.
    return false;
  }

  const logger = funcLogger.child({ helper: 'queue', func: 'executeQueue' });

  await modifiers.preprocessFn();

  logger.info({ symbol }, `Queue ${symbol} job preprocessed`);

  await executeTrailingTrade(
    funcLogger,
    symbol,
    _.get(jobData, 'correlationId')
  );

  return true;
};

/**
 * Execute queue or preprocessFn
 *
 * @param {*} funcLogger
 * @param {*} symbol
 * @param {*} modifiers
 * @param {*} jobData
 */
const execute = async (
  funcLogger,
  symbol,
  modifiers = { queue: true },
  jobData = {}
) => {
  const logger = funcLogger.child({ helper: 'queue' });

  // Use chain of resposibilities pattern to handle the job execution.
  // eslint-disable-next-line no-restricted-syntax
  for (const executeFn of [executeQueue, executePreprocessFn]) {
    // eslint-disable-next-line no-await-in-loop
    const result = await executeFn(logger, symbol, modifiers, jobData);

    if (result) {
      logger.info({ symbol }, 'Queue executed successfully.');
      break;
    }
  }
};

module.exports = {
  init,
  execute
};
