const { logger } = require('./helpers');
const { runCronjob } = require('./server-cronjob');
const { runWebSocket } = require('./server-websocket');
const { runFrontend } = require('./server-frontend');

runCronjob(logger);

runWebSocket(logger);

runFrontend(logger);
