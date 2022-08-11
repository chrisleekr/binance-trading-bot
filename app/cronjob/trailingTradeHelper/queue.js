const config = require('config');
const Queue = require('bull');
const _ = require('lodash');
const { executeTrailingTrade } = require('../index');

let queues = {};

const create = (funcLogger, symbol) => {
  const logger = funcLogger.child({ helper: 'queue' });

  const queue = new Queue(
    symbol,
    `redis://:${config.get('redis.password')}@${config.get(
      'redis.host'
    )}:${config.get('redis.port')}/${config.get('redis.db')}`
  );
  queue.process(_job => executeTrailingTrade(logger, symbol));

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

  await queues[symbol].add({});
};

module.exports = {
  init,
  executeFor
};
