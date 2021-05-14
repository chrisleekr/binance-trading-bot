/* istanbul ignore file */
const WebSocket = require('ws');
const { logger } = require('../helpers');

(async () => {
  // eslint-disable-next-line no-undef
  const socket = new WebSocket(
    'wss://stream.binance.com:9443/ws/btcusdt@kline_1m'
  );
  socket.onopen = () => {
    logger.info('connected to the server');
  };

  socket.onmessage = message => {
    logger.info('Received:', message.data);
  };

  socket.onerror = error => {
    logger.error(`WebSocket error: ${error}`);
  };
})();
