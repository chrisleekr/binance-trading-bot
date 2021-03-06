const config = require('config');
const Redis = require('ioredis');

const redis = new Redis({
  host: config.get('redis.host'),
  port: config.get('redis.port'),
  password: config.get('redis.password')
});

/**
 * Set cache value
 *
 * @param {*} key
 * @param {*} value
 * @param {*} ttl seconds
 */
const set = async (key, value, ttl = undefined) => {
  if (ttl) {
    return redis.set(key, value, 'EX', ttl);
  }
  return redis.set(key, value);
};

/**
 * Get value from key
 *
 * @param {*} key
 */
const get = async key => redis.get(key);

/**
 * Set cache value
 *
 * @param {*} key
 * @param {*} field
 * @param {*} value
 */
const hset = async (key, field, value) => redis.hset(key, field, value);

/**
 * Get value from key
 *
 * @param {*} key
 * @param {*} field
 */
const hget = async (key, field) => redis.hget(key, field);

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
const hdel = async (key, field) => redis.hdel(key, field);

module.exports = { set, get, hset, hget, hgetall, hdel };
