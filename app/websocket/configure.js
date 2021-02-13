const WebSocket = require('ws');
const {
  handleLatest,
  handleSettingUpdate,
  handleSymbolUpdate,
  handleSymbolDelete
} = require('./handlers');

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

const configureWebSocket = async (server, funcLogger) => {
  const logger = funcLogger.child({ server: 'websocket' });
  const wss = new WebSocket.Server({
    noServer: true
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
        case 'symbol-update':
          await handleSymbolUpdate(logger, ws, payload);
          break;
        case 'symbol-delete':
          await handleSymbolDelete(logger, ws, payload);
          break;
        default:
          handleWarning(logger, ws, 'Command is not recognised.');
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

  server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, wSocket => {
      wss.emit('connection', wSocket, request);
    });
  });

  return wss;
};

module.exports = { configureWebSocket };
