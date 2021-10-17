const _ = require('lodash');
const moment = require('moment');
const bunyan = require('bunyan');
const packageJson = require('../../package.json');

const mongo = require('./mongo');

/* istanbul ignore next */
const fakeLogger = {
  child: _childData => ({
    info: (..._infoData) => {}
  })
};

// This variable will store last log per symbol to avoid saving the duplicated log.
const lastLogs = {};

function InfoStream() {}
InfoStream.prototype.write = rawLog => {
  const log = JSON.parse(rawLog);

  if (_.get(log, 'symbol', '') !== '' && _.get(log, 'saveLog', false)) {
    if (_.get(lastLogs, `${log.symbol}.message`, '') !== log.msg) {
      mongo.insertOne(fakeLogger, 'trailing-trade-logs', {
        symbol: log.symbol,
        msg: log.msg,
        loggedAt: moment(log.time).toDate(),
        data: _.omit(log, [
          'msg',
          'symbol',
          'name',
          'version',
          'hostname',
          'pid',
          'gitHash',
          'server',
          'job',
          'level',
          'saveLog',
          'time',
          'v'
        ])
      });
      lastLogs[log.symbol] = { message: log.msg };
    }
  }
};

const logger = bunyan.createLogger({
  name: 'binance-api',
  version: packageJson.version,
  serializers: bunyan.stdSerializers,
  streams: [
    {
      stream: process.stdout,
      level: process.env.BINANCE_LOG_LEVEL || 'TRACE'
    },
    {
      stream: new InfoStream(),
      level: 'INFO'
    }
  ]
});
logger.info({ NODE_ENV: process.env.NODE_ENV }, 'API logger loaded');

module.exports = logger;
