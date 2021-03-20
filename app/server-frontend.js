const express = require('express');
const basicAuth = require('express-basic-auth');
const path = require('path');
const config = require('config');

const { configureWebSocket } = require('./websocket/configure');
const { configureLocalTunnel } = require('./local-tunnel/configure');

const runFrontend = async serverLogger => {
  const logger = serverLogger.child({ server: 'frontend' });
  logger.info({ config }, `API ${config.get('mode')} frontend started on`);

  const app = express();
  const usersData = {};
  usersData[config.frontend_auth.username] = config.frontend_auth.password;
  app.use(
    basicAuth({
      users: usersData,
      challenge: true,
      realm: 'Binance Trading Bot'
    })
  );
  app.use(express.static(path.join(__dirname, '/../public')));

  const server = app.listen(80);

  await configureWebSocket(server, logger);
  await configureLocalTunnel(logger);
};

module.exports = { runFrontend };
