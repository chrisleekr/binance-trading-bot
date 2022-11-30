const config = require('config');
const Queue = require('bull');
const _ = require('lodash');
const { executeTrailingTrade } = require('../cronjob');
const { setBullBoardQueues } = require('../frontend/bull-board/configure');

let queues = {};

const REDIS_URL = `redis://:${config.get('redis.password')}@${config.get(
  'redis.host'
)}:${config.get('redis.port')}/${config.get('redis.db')}`;

const createQueue = (_funcLogger, queueName, concurrency, jobFunc) => {
  const queue = new Queue(queueName, REDIS_URL, {
    prefix: `bull`,
    settings: {
      guardInterval: 1000 // Poll interval for delayed jobs and added jobs.
    }
  });
  // Define job function with concurrency
  queue.process(concurrency, jobFunc);

  return queue;
};

const resetQueues = async () => {
  // Completely remove all queues with their data
  await Promise.all(_.map(queues, queue => queue.obliterate({ force: true })));
  queues = {};
};

const init = async (funcLogger, symbols) => {
  // Create queues for symbols
  await Promise.all(
    _.map(symbols, async symbol => {
      queues[symbol] = createQueue(funcLogger, symbol, 1, async _job =>
        executeTrailingTrade(funcLogger, symbol)
      );
    })
  );

  // Set bull board queues
  setBullBoardQueues(queues, funcLogger);
};

/**
 * Add a queue job to the queue
 *
 * @param {*} funcLogger
 * @param {*} queueName
 */
const executeFor = async (funcLogger, queueName) => {
  const logger = funcLogger.child({ helper: 'queue' });

  if (!(queueName in queues)) {
    logger.error({ queueName }, `No queue created for ${queueName}`);
    return;
  }

  await queues[queueName].add(
    {},
    {
      removeOnComplete: 100 // number specified the amount of jobs to keep.
    }
  );
};

module.exports = {
  resetQueues,
  init,
  executeFor
};
