const bunyan = require('bunyan');
const packageJson = require('../../package.json');

const logger = bunyan.createLogger({
  name: 'api',
  version: packageJson.version,
  streams: [{ stream: process.stdout, level: process.env.NODE_ENV !== 'test' ? bunyan.TRACE : bunyan.FATAL }]
});
logger.info({ NODE_ENV: process.env.NODE_ENV }, 'API logger loaded');

module.exports = logger;
