const WebSocket = require('ws');

const {
  verifyAuthenticated
} = require('../../cronjob/trailingTradeHelper/common');

const { PubSub } = require('../../helpers');

const {
  handleLatest,
  handleSettingUpdate,
  handleSymbolUpdateLastBuyPrice,
  handleSymbolDelete,
  handleSymbolSettingUpdate,
  handleSymbolSettingDelete,
  handleSymbolGridTradeDelete,
  handleSymbolEnableAction,
  handleSymbolTriggerBuy,
  handleSymbolTriggerSell,
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
      type: 'notification',
      message: {
        type: 'warning',
        title: message
      }
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
        handleWarning(logger, ws, 'Command is not provided.');
        return;
      }

      const commandLogger = logger.child({ payload });

      const commandMaps = {
        latest: handleLatest,
        'setting-update': handleSettingUpdate,
        'symbol-update-last-buy-price': handleSymbolUpdateLastBuyPrice,
        'symbol-delete': handleSymbolDelete,
        'symbol-setting-update': handleSymbolSettingUpdate,
        'symbol-setting-delete': handleSymbolSettingDelete,
        'symbol-grid-trade-delete': handleSymbolGridTradeDelete,
        'symbol-enable-action': handleSymbolEnableAction,
        'symbol-trigger-buy': handleSymbolTriggerBuy,
        'symbol-trigger-sell': handleSymbolTriggerSell,
        'manual-trade': handleManualTrade,
        'manual-trade-all-symbols': handleManualTradeAllSymbols,
        'cancel-order': handleCancelOrder,
        'dust-transfer-get': handleDustTransferGet,
        'dust-transfer-execute': handleDustTransferExecute
      };

      if (commandMaps[payload.command] === undefined) {
        handleWarning(logger, ws, 'Command is not recognised.');
        return;
      }

      const isAuthenticated = await verifyAuthenticated(
        commandLogger,
        payload.authToken
      );
      if (payload.command === 'latest') {
        // Latest command will handle authentication separately.
        payload.isAuthenticated = isAuthenticated;
      } else if (isAuthenticated === false) {
        // Must be authenticated for other commands.
        handleWarning(logger, ws, 'You must be authenticated.');
        return;
      }

      await commandMaps[payload.command](commandLogger, ws, payload);
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
