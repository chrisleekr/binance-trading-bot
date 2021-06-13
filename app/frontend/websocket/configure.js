const WebSocket = require('ws');
const { PubSub } = require('../../helpers');

const {
  handleLatest,
  handleSettingUpdate,
  handleSymbolUpdateLastBuyPrice,
  handleSymbolDelete,
  handleSymbolSettingUpdate,
  handleSymbolSettingDelete,
  handleSymbolEnableAction,
  handleManualTrade,
  handleManualTradeAllSymbols,
  handleCancelOrder,
  handleDustTransferGet,
  handleDustTransferExecute
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

      const commandLogger = logger.child({ payload });

      switch (payload.command) {
        case 'latest':
          await handleLatest(commandLogger, ws, payload);
          break;
        case 'setting-update':
          await handleSettingUpdate(commandLogger, ws, payload);
          break;
        case 'symbol-update-last-buy-price':
          await handleSymbolUpdateLastBuyPrice(commandLogger, ws, payload);
          break;
        case 'symbol-delete':
          await handleSymbolDelete(commandLogger, ws, payload);
          break;
        case 'symbol-setting-update':
          await handleSymbolSettingUpdate(commandLogger, ws, payload);
          break;
        case 'symbol-setting-delete':
          await handleSymbolSettingDelete(commandLogger, ws, payload);
          break;
        case 'symbol-enable-action':
          await handleSymbolEnableAction(commandLogger, ws, payload);
          break;
        case 'manual-trade':
          await handleManualTrade(commandLogger, ws, payload);
          break;
        case 'manual-trade-all-symbols':
          await handleManualTradeAllSymbols(commandLogger, ws, payload);
          break;
        case 'cancel-order':
          await handleCancelOrder(commandLogger, ws, payload);
          break;
        case 'dust-transfer-get':
          await handleDustTransferGet(commandLogger, ws, payload);
          break;
        case 'dust-transfer-execute':
          await handleDustTransferExecute(commandLogger, ws, payload);
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

    PubSub.subscribe('frontend-notification', async (message, data) => {
      logger.info(
        { tag: 'frontend-notification' },
        `Message: ${message}, Data: ${data}`
      );
      ws.send(
        JSON.stringify({
          result: true,
          type: 'notification',
          message: data
        })
      );
    });
  });

  server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, wSocket => {
      wss.emit('connection', wSocket, request);
    });
  });

  return wss;
};

module.exports = { configureWebSocket };
