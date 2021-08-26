const bunyan = require('bunyan');
const packageJson = require('../../package.json');

const logger = bunyan.createLogger({
  name: 'binance-api',
  version: packageJson.version,
  serializers: bunyan.stdSerializers,
  streams: [
    {
      stream: process.stdout,
      level: process.env.BINANCE_LOG_LEVEL || 'TRACE'
    }
  ]
});
logger.info({ NODE_ENV: process.env.NODE_ENV }, 'API logger loaded');

module.exports = logger;
