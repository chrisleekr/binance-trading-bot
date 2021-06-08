const config = require('config');
const Redis = require('ioredis');
const Redlock = require('redlock');

const redis = new Redis({
  host: config.get('redis.host'),
  port: config.get('redis.port'),
  password: config.get('redis.password')
});

const redlock = new Redlock([redis], {
  // the expected clock drift; for more details
  // see http://redis.io/topics/distlock
  driftFactor: 0.01, // multiplied by lock ttl to determine drift time

  // the max number of times Redlock will attempt
  // to lock a resource before erroring
  retryCount: 1,

  // the time in ms between attempts
  retryDelay: 10, // time in ms

  // the max time in ms randomly added to retries
  // to improve performance under high contention
  // see https://www.awsarchitectureblog.com/2015/03/backoff.html
  retryJitter: 10 // time in ms
});

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
 */
const hset = async (key, field, value) => {
  const lock = await redlock.lock(`redlock:${key}:${field}`, 500);
  const result = await redis.hset(key, field, value);
  await lock.unlock();
  return result;
};

/**
 * Get value from key
 *
 * @param {*} key
 * @param {*} field
 */
const hget = async (key, field) => {
  const lock = await redlock.lock(`redlock:${key}:${field}`, 500);
  const result = await redis.hget(key, field);
  await lock.unlock();
  return result;
};

/**
 * Get value from key wihtout lock
 * @param {*} key
 * @param {*} field
 * @returns
 */
const hgetWithoutLock = async (key, field) => redis.hget(key, field);

/**
 * Get value from key
 *
 * @param {*} key
 */
const hgetall = async key => redis.hgetall(key);

/**
 * Delete key/field
 *
 * @param {*} key
 * @param {*} field
 */
const hdel = async (key, field) => {
  const lock = await redlock.lock(`redlock:${key}:${field}`, 500);
  const result = await redis.hdel(key, field);
  await lock.unlock();
  return result;
};

module.exports = {
  set,
  get,
  getWithTTL,
  del,
  hset,
  hgetWithoutLock,
  hget,
  hgetall,
  hdel
};
