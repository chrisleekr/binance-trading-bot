const config = require('config');
const Redis = require('ioredis');
const Redlock = require('redlock');

const redis = new Redis({
  host: config.get('redis.host'),
  port: config.get('redis.port'),
  password: config.get('redis.password'),
  db: config.get('redis.db')
});

const redlock = new Redlock([redis], {
  // the expected clock drift; for more details
  // see http://redis.io/topics/distlock
  driftFactor: 0.01, // multiplied by lock ttl to determine drift time

  // the max number of times Redlock will attempt
  // to lock a resource before erroring
  retryCount: 4,

  // the time in ms between attempts
  retryDelay: 200, // time in ms

  // the max time in ms randomly added to retries
  // to improve performance under high contention
  // see https://www.awsarchitectureblog.com/2015/03/backoff.html
  retryJitter: 200 // time in ms
});

/**
 * Get keys
 *
 * @param {*} pattern
 * @returns
 */
const keys = async pattern => redis.keys(pattern);

/**
 * Set cache value
 *
 * @param {*} key
 * @param {*} value
 * @param {*} ttl seconds
 */
const set = async (key, value, ttl = undefined) => {
  const lock = await redlock.lock(`redlock:${key}`, 500);

  let result;
  if (ttl) {
    result = await redis.setex(key, ttl, value);
  } else {
    result = await redis.set(key, value);
  }

  await lock.unlock();
  return result;
};

/**
 * Get value from key
 *
 * return true;
 * @param {*} key
 */
const get = async key => {
  const lock = await redlock.lock(`redlock:${key}`, 500);
  const result = await redis.get(key);
  await lock.unlock();

  return result;
};

/**
 * Get value from key without lock
 *
 * return true;
 * @param {*} key
 */
const getWithoutLock = async key => redis.get(key);

/**
 *
 * Get value with TTL
 *
 * @param {*} key
 * @returns
 */
const getWithTTL = async key => redis.multi().ttl(key).get(key).exec();

/**
 * Delete key
 *
 * @param {*} key
 */
const del = async key => {
  const lock = await redlock.lock(`redlock:${key}`, 500);
  const result = await redis.del(key);
  await lock.unlock();
  return result;
};

/**
 * Set cache value
 *
 * @param {*} key
 * @param {*} field
 * @param {*} value
 * @param {*} ttl
 */
const hset = async (key, field, value, ttl = undefined) => {
  const newKey = `${key}:${field}`;

  return set(newKey, value, ttl);
};

/**
 * Get value from key
 *
 * @param {*} key
 * @param {*} field
 */
const hget = async (key, field) => {
  const newKey = `${key}:${field}`;

  return get(newKey);
};

/**
 * Get value from key wihtout lock
 * @param {*} key
 * @param {*} field
 * @returns
 */
const hgetWithoutLock = async (key, field) => {
  const newKey = `${key}:${field}`;

  return getWithoutLock(newKey);
};

/**
 * Get value from key
 *
 * @param {*} prefix
 * @param {*} pattern
 * @param {*} cursor
 * @param {*} result
 */
const hgetall = async (prefix, pattern, cursor = '0', result = {}) => {
  const newResult = result;
  const reply = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 1000);

  const replyCursor = reply[0];
  // Retrieve all values

  if (reply[1]) {
    await Promise.all(
      reply[1].map(async replyKey => {
        newResult[replyKey.replace(prefix, '')] = await getWithoutLock(
          replyKey
        );
      })
    );
  }

  if (replyCursor === '0') {
    // no more cursor

    return newResult;
  }

  // has more cursor
  return hgetall(prefix, pattern, replyCursor, newResult);
};

/**
 * Delete key/field
 *
 * @param {*} key
 * @param {*} field
 */
const hdel = async (key, field) => {
  const newKey = `${key}:${field}`;
  return del(newKey);
};

/**
 * Delete all matching keys
 *
 * @param {*} pattern
 * @param {*} cursor
 * @returns
 */
const hdelall = async (pattern, cursor = '0') => {
  const reply = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 1000);

  const replyCursor = reply[0];

  if (reply[1]) {
    await Promise.all(reply[1].map(async replyKey => del(replyKey)));
  }

  if (replyCursor === '0') {
    // no more cursor

    return true;
  }

  // has more cursor
  return hdelall(pattern, replyCursor);
};

module.exports = {
  redis,
  keys,
  set,
  get,
  getWithTTL,
  del,
  hset,
  hgetWithoutLock,
  hget,
  hgetall,
  hdel,
  hdelall
};
