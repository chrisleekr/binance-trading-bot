const express = require('express');
const path = require('path');

const config = require('config');

const runFrontend = serverLogger => {
  const logger = serverLogger.child({ server: 'frontend' });
  logger.info({ config }, `API ${config.get('mode')} frontend started on`);
  const server = express();
  server.use(express.static(path.join(__dirname, '/../public')));

  server.listen(80);
};

module.exports = { runFrontend };
