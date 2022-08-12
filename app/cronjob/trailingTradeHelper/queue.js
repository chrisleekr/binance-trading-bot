const config = require('config');
const Queue = require('bull');
const _ = require('lodash');
const { executeTrailingTrade } = require('../index');
const { setBullBoardQueues } = require('../../frontend/bull-board/configure');

let queues = {};

const REDIS_URL = `redis://:${config.get('redis.password')}@${config.get(
  'redis.host'
)}:${config.get('redis.port')}/${config.get('redis.db')}`;

const create = (funcLogger, symbol) => {
  const logger = funcLogger.child({ helper: 'queue' });

  const queue = new Queue(symbol, REDIS_URL, {
    prefix: `bull`,
    settings: {
      guardInterval: 1000 // Poll interval for delayed jobs and added jobs.
    }
  });
  // Set concurrent for the job
  queue.process(1, async _job => executeTrailingTrade(logger, symbol));

  return queue;
};

const init = async (funcLogger, symbols) => {
  // Completely remove all queues with their data
  await Promise.all(_.map(queues, queue => queue.obliterate({ force: true })));
  queues = {};

  await Promise.all(
    _.map(symbols, async symbol => {
      queues[symbol] = create(funcLogger, symbol);
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
const executeFor = async (funcLogger, symbol) => {
  const logger = funcLogger.child({ helper: 'queue' });

  if (!(symbol in queues)) {
    logger.error({ symbol }, `No queue created for ${symbol}`);
    return;
  }

  await queues[symbol].add(
    {},
    {
      removeOnComplete: 100 // number specified the amount of jobs to keep.
    }
  );
};

module.exports = {
  init,
  executeFor
};
