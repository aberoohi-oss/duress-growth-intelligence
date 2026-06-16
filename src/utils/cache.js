const NodeCache = require('node-cache');
const logger = require('./logger');

const TTL = parseInt(process.env.CACHE_TTL_SECONDS || '1800', 10);

const cache = new NodeCache({ stdTTL: TTL, checkperiod: 120 });

cache.on('set', (key) => logger.debug(`Cache SET: ${key}`));
cache.on('del', (key) => logger.debug(`Cache DEL: ${key}`));
cache.on('expired', (key) => logger.debug(`Cache EXPIRED: ${key}`));

function buildKey(prefix, params = {}) {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return sorted ? `${prefix}:${sorted}` : prefix;
}

module.exports = {
  get: (key) => cache.get(key),
  set: (key, value, ttl) => (ttl !== undefined ? cache.set(key, value, ttl) : cache.set(key, value)),
  del: (key) => cache.del(key),
  flush: () => cache.flushAll(),
  buildKey,
  stats: () => cache.getStats(),
};
