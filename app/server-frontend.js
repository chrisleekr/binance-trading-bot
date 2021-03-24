const express = require('express');
const path = require('path');
const config = require('config');

const { configureWebSocket } = require('./websocket/configure');
const { configureLocalTunnel } = require('./local-tunnel/configure');
const { setBasicAuth } = require('./frontend/basic-auth');

const runFrontend = async serverLogger => {
  const logger = serverLogger.child({ server: 'frontend' });
  logger.info({ config }, `API ${config.get('mode')} frontend started on`);

  const app = express();

  setBasicAuth(app, logger);
  app.use(express.static(path.join(__dirname, '/../public')));

  const server = app.listen(80);

  await configureWebSocket(server, logger);
  await configureLocalTunnel(logger);
};

module.exports = { runFrontend };
