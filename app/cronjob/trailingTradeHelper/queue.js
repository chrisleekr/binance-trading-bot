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
 * Start, preprocess, execute, postprocess and finish the job in queue
 *
 * @param {*} funcLogger
 * @param {*} symbol
 * @param {*} parameters
 * @param {*} jobData
 */
const execute = async (
  funcLogger,
  symbol,
  parameters = { start: true, execute: true, finish: true },
  jobData = {}
) => {
  const logger = funcLogger.child({ helper: 'queue' });

  if ((parameters.start || parameters.finish) && !(symbol in startedJobs)) {
    logger.error({ symbol }, `No queue created for ${symbol}`);
    return;
  }

  // Start
  if (parameters.start) {
    const pos = (startedJobs[symbol] += 1) - 1;

    if (pos > finishedJobs[symbol]) {
      logger.info({ symbol }, `Queue ${symbol} job #${pos} waiting`);
      while (pos > finishedJobs[symbol]) {
        // eslint-disable-next-line no-await-in-loop, no-promise-executor-return
        await new Promise(r => setTimeout(r, 10));
      }
    }

    logger.info({ symbol }, `Queue ${symbol} job #${pos} started`);
  }

  // Preprocess
  let canExecuteTrailingTrade;
  if (parameters.preprocessFn) {
    canExecuteTrailingTrade = await parameters.preprocessFn();

    logger.info({ symbol }, `Queue ${symbol} job preprocessed`);
  }

  // Execute (if preprocessed)
  if (parameters.execute !== undefined) {
    canExecuteTrailingTrade = parameters.execute;
  }
  if (canExecuteTrailingTrade) {
    await executeTrailingTrade(
      funcLogger,
      symbol,
      _.get(jobData, 'correlationId')
    );
  }

  // Postprocess
  if (parameters.postprocessFn) {
    await parameters.postprocessFn();

    logger.info({ symbol }, `Queue ${symbol} job postprocessed`);
  }

  // Finish
  if (parameters.finish) {
    const pos = (finishedJobs[symbol] += 1) - 1;

    if (startedJobs[symbol] === finishedJobs[symbol]) {
      // Last job in the queue finished
      // Reset the counters
      startedJobs[symbol] = (finishedJobs[symbol] -= startedJobs[symbol]) + 0;
    }

    logger.info({ symbol }, `Queue ${symbol} job #${pos} finished`);
  }
};

module.exports = {
  init,
  execute
};
