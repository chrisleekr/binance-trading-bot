const { v4: uuidv4 } = require('uuid');
const WebSocket = require('ws');
const config = require('config');

const {
  verifyAuthenticated
} = require('../../cronjob/trailingTradeHelper/common');

const { PubSub } = require('../../helpers');

const {
  handleLatest,
  handleSettingUpdate,
  handleSymbolUpdateLastBuyPrice,
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
  handleDustTransferExecute,
  handleExchangeSymbolsGet
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

const configureWebSocket = async (server, funcLogger, { loginLimiter }) => {
  const logger = funcLogger.child({ server: 'websocket' });
  const wss = new WebSocket.Server({
    noServer: true
  });

  wss.on('connection', ws => {
    ws.on('message', async message => {
      logger.info({ message }, 'received');

      // eslint-disable-next-line no-underscore-dangle
      const clientIp = ws._socket.remoteAddress;
      const rateLimiterLogin = await loginLimiter.get(clientIp);

      if (
        config.get('authentication.enabled') &&
        rateLimiterLogin.remainingPoints <= 0
      ) {
        handleWarning(
          logger,
          ws,
          `You are blocked until ${new Date(
            Date.now() + rateLimiterLogin.msBeforeNext
          )}.`
        );
        return;
      }

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

      const commandLogger = logger.child({ payload, correlationId: uuidv4() });

      const commandMaps = {
        latest: handleLatest,
        'setting-update': handleSettingUpdate,
        'symbol-update-last-buy-price': handleSymbolUpdateLastBuyPrice,
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
        'dust-transfer-execute': handleDustTransferExecute,
        'exchange-symbols-get': handleExchangeSymbolsGet
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
