const config = require('config');
const Queue = require('bull');
const _ = require('lodash');
const { executeTrailingTrade } = require('../index');
const { setBullBoardQueues } = require('../../frontend/bull-board/configure');

let queues = {};
let paused = {};
let resumed = {};

const REDIS_URL = `redis://:${config.get('redis.password')}@${config.get(
  'redis.host'
)}:${config.get('redis.port')}/${config.get('redis.db')}`;

const pause = async (funcLogger, symbol) => {
  const logger = funcLogger.child({ helper: 'queue' });

  // eslint-disable-next-line no-plusplus
  const pos = paused[symbol]++;
  if (pos > resumed[symbol]) {
    logger.info({ symbol }, `Queue ${symbol} pause #${pos} queued`);
    while (pos > resumed[symbol]) {
      // eslint-disable-next-line no-await-in-loop, no-promise-executor-return
      await new Promise(r => setTimeout(r, 10));
    }
  }

  await queues[symbol].pause();

  logger.info({ symbol }, `Queue ${symbol} paused #${pos}`);
};

const resume = async (funcLogger, symbol) => {
  const logger = funcLogger.child({ helper: 'queue' });

  // eslint-disable-next-line no-plusplus
  const pos = resumed[symbol]++;

  if (paused[symbol] === resumed[symbol]) {
    // eslint-disable-next-line no-multi-assign
    paused[symbol] = resumed[symbol] = 0;
  }

  await queues[symbol].resume();

  logger.info({ symbol }, `Queue ${symbol} resumed #${pos}`);

  if (paused[symbol] === 0) {
    logger.info({ symbol }, `Queue ${symbol} resumed last`);
  }
};

const waitForJob = async (funcLogger, symbol) => {
  const logger = funcLogger.child({ helper: 'queue' });

  let active = await queues[symbol].getActiveCount();
  if (active > 0) {
    logger.info({ symbol }, `Queue ${symbol} wait for ${active} job(s)`);

    while (active > 0) {
      // eslint-disable-next-line no-await-in-loop, no-promise-executor-return
      await new Promise(r => setTimeout(r, 10));
      // eslint-disable-next-line no-await-in-loop
      active = await queues[symbol].getActiveCount();
    }
  }

  logger.info({ symbol }, `Queue ${symbol} inactive`);
};

const hold = async (funcLogger, symbol) => {
  const logger = funcLogger.child({ helper: 'queue' });

  if (!(symbol in queues)) {
    logger.error({ symbol }, `No queue created for ${symbol} pause`);
    return;
  }

  await pause(funcLogger, symbol);
  await waitForJob(funcLogger, symbol);
};

const create = (funcLogger, symbol) => {
  const logger = funcLogger.child({ helper: 'queue' });

  const queue = new Queue(symbol, REDIS_URL, {
    prefix: `bull`,
    limiter: {
      max: 100,
      duration: 10000, // 10 seconds
      // bounceBack: When jobs get rate limited, they stay in the waiting queue and are not moved to the delayed queue
      bounceBack: true
    }
  });
  // Set concurrent for the job
  queue.process(1, async job => {
    await executeTrailingTrade(
      logger,
      symbol,
      _.get(job.data, 'correlationId')
    );

    job.progress(100);
  });

  return queue;
};

const init = async (funcLogger, symbols) => {
  // Completely remove all queues with their data
  await Promise.all(_.map(queues, queue => queue.obliterate({ force: true })));
  queues = {};
  paused = {};
  resumed = {};

  await Promise.all(
    _.map(symbols, async symbol => {
      queues[symbol] = create(funcLogger, symbol);
      paused[symbol] = 0;
      resumed[symbol] = 0;
    })
  );

  // Set bull board queues
  setBullBoardQueues(queues, funcLogger);
};

/**
 * Add executeTrailingTrade job to the queue of a symbol
 *
 * @param {*} funcLogger
 * @param {*} symbol
 */
const executeFor = async (funcLogger, symbol, jobData = {}) => {
  const logger = funcLogger.child({ helper: 'queue' });

  if (!(symbol in queues)) {
    logger.error({ symbol }, `No queue created for ${symbol}`);
    return;
  }

  const waiting = await queues[symbol].getWaitingCount();
  if (waiting > 0) {
    logger.info({ symbol }, `Already waiting ${waiting} job(s) in ${symbol}`);
  } else {
    logger.info({ symbol }, `Added job for ${symbol}`);
    await queues[symbol].add(jobData, {
      removeOnComplete: 100 // number specified the amount of jobs to keep.
    });
  }

  if (await queues[symbol].isPaused()) {
    await resume(funcLogger, symbol);
  }
};

module.exports = {
  init,
  hold,
  executeFor
};
