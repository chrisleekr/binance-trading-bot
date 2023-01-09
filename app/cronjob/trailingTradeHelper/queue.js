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
 * @param {*} modifiers
 * @param {*} jobData
 */
const execute = async (funcLogger, symbol, modifiers = {}, jobData = {}) => {
  const logger = funcLogger.child({ helper: 'queue' });

  if (modifiers.queue !== false && !(symbol in startedJobs)) {
    logger.error({ symbol }, `No queue created for ${symbol}`);
    return;
  }

  // Start
  if (modifiers.queue !== false) {
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
  if (modifiers.preprocessFn) {
    canExecuteTrailingTrade = await modifiers.preprocessFn();

    logger.info({ symbol }, `Queue ${symbol} job preprocessed`);
  }

  // Execute (if preprocessed)
  if (modifiers.queue !== undefined) {
    canExecuteTrailingTrade = modifiers.execute;
  }
  if (canExecuteTrailingTrade !== false) {
    await executeTrailingTrade(
      funcLogger,
      symbol,
      _.get(jobData, 'correlationId')
    );
  }

  // Postprocess
  if (modifiers.postprocessFn) {
    await modifiers.postprocessFn();

    logger.info({ symbol }, `Queue ${symbol} job postprocessed`);
  }

  // Finish
  if (modifiers.queue !== false) {
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
