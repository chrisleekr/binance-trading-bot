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
const set = (key, value, ttl = undefined) => {
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
const get = key => {
  return redis.get(key);
};

module.exports = { set, get };
