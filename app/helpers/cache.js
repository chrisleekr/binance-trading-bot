const NodeCache = require('node-cache');

const nodeCache = new NodeCache();

const set = (key, obj, ttl) => {
  return nodeCache.set(key, obj, ttl);
};

const get = key => {
  return nodeCache.get(key);
};

module.exports = { set, get };
