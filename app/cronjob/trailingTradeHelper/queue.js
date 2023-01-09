const config = require('config');
const Queue = require('bull');
const _ = require('lodash');
const { executeTrailingTrade } = require('../index');
const { setBullBoardQueues } = require('../../frontend/bull-board/configure');

const { getTradingView } = require('../trailingTradeIndicator/steps');

let queues = {};

const REDIS_URL = `redis://:${config.get('redis.password')}@${config.get(
  'redis.host'
)}:${config.get('redis.port')}/${config.get('redis.db')}`;

const create = (queueName, queueOptions, queueProcessFn) => {
  const queue = new Queue(queueName, REDIS_URL, {
    prefix: `bull`,
    limiter: {
      max: 100,
      duration: 10000, // 10 seconds
      // bounceBack: When jobs get rate limited, they stay in the waiting queue and are not moved to the delayed queue
      bounceBack: true
    },
    ...queueOptions
  });
  // Set concurrent for the job
  queue.process(1, queueProcessFn);

  return queue;
};

const initSymbols = async (funcLogger, symbols) =>
  Promise.all(
    _.map(symbols, async symbol => {
      const queueName = `SYMBOL:${symbol}`;
      const logger = funcLogger.child({ helper: 'queue', queueName });
      queues[queueName] = create(queueName, {}, async job => {
        await executeTrailingTrade(
          logger,
          symbol,
          _.get(job.data, 'correlationId')
        );

        job.progress(100);
      });
    })
  );

const initTradingview = async (funcLogger, globalConfiguration) => {
  const queueName = `TRADINGVIEW`;
  const logger = funcLogger.child({ helper: 'queue', queueName });

  queues[queueName] = create(queueName, {}, async job => {
    await getTradingView(logger, {
      globalConfiguration
    });

    job.progress(100);
  });

  await queues[queueName].add(
    {},
    {
      // delay: 1000,
      // attempts: 3,
      repeat: {
        cron: '*/1 * * * * *'
        // every: 1000,
        // limit: 0
      },
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: 100,
      timeout: 2000
    }
  );
};

const init = async (funcLogger, { symbols, globalConfiguration }) => {
  // Completely remove all queues with their data
  await Promise.all(_.map(queues, queue => queue.obliterate({ force: true })));
  queues = {};

  // Set up queue for symbols
  await initSymbols(funcLogger, symbols);

  // Set up queue for Tradingview
  await initTradingview(funcLogger, globalConfiguration);

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

  const queueName = `SYMBOL:${symbol}`;
  if (!(queueName in queues)) {
    logger.error({ queueName }, `No queue created for ${queueName}`);
    return;
  }

  await queues[queueName].add(jobData, {
    removeOnComplete: 100 // number specified the amount of jobs to keep.
  });
};

module.exports = {
  init,
  executeFor
};
