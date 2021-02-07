const config = require('config');
const WebSocket = require('ws');
const {
  handleLatest,
  handleSettingUpdate,
  handleSymbolDelete
} = require('./websocket');

const handleWarning = (logger, ws, message) => {
  logger.warn({ message }, 'Warning occurred');
  ws.send(
    JSON.stringify({
      result: false,
      type: 'error',
      message
    })
  );
};

const runWebSocket = serverLogger => {
  const logger = serverLogger.child({ server: 'websocket' });
  logger.info({ config }, `API ${config.get('mode')} websocket started on`);

  const wss = new WebSocket.Server({
    port: 81
  });

  wss.on('connection', ws => {
    ws.on('message', async message => {
      logger.info({ message }, 'received');

      let payload;
      try {
        payload = JSON.parse(message);
      } catch (e) {
        payload = null;
      }
      if (payload === null || payload.command === undefined) {
        ws.send(handleWarning(logger, ws, 'Command is not provided.'));
        return;
      }

      switch (payload.command) {
        case 'latest':
          await handleLatest(logger, ws, payload);
          break;
        case 'setting-update':
          await handleSettingUpdate(logger, ws, payload);
          break;
        case 'symbol-delete':
          await handleSymbolDelete(logger, ws, payload);
          break;
        default:
          ws.send(handleWarning(logger, ws, 'Command is not recognised.'));
      }
    });

    ws.send(
      JSON.stringify({
        result: true,
        type: 'connection_success',
        message: 'You are successfully connected to WebSocket.'
      })
    );
  });

  return { wss };
};

module.exports = { runWebSocket };
