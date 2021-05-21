const localtunnel = require('localtunnel');
const moment = require('moment-timezone');
const config = require('config');
const { slack, cache } = require('../../helpers');

let isReconnecting = false;
let retryMs = 60 * 60 * 1000; // 1 hour

/**
 * Reconnect in provided ms later
 *
 * @param {*} logger
 * @param {*} message
 * @param {*} ms
 * @returns
 */
const reconnect = (logger, message, ms) => {
  // It's already attempting to reconnect, return
  if (isReconnecting === true) {
    return;
  }

  isReconnecting = true;
  if (config.get('featureToggle.notifyDebug')) {
    slack.sendMessage(
      `Local Tunnel (${moment().format('HH:mm:ss.SSS')}): ${message}`
    );
  }
  logger.warn(message);

  // eslint-disable-next-line no-use-before-define
  setTimeout(() => connect(logger), ms);

  // Add extra minute to avoid connecting like every minute. Eventually, should get configured subdomain back.
  retryMs += 60 * 60 * 1000;
};

/**
 * Connect to the local tunnel
 *
 * @param {*} logger
 * @returns
 */
const connect = async logger => {
  if (config.get('localTunnel.enabled') !== true) {
    logger.info('Local tunnel is disabled');
    await cache.hdel('trailing-trade-common', 'local-tunnel-url');
    return false;
  }

  logger.info('Attempt connecting local tunnel');
  let tunnel;
  try {
    tunnel = await localtunnel({
      port: 80,
      subdomain: config.get('localTunnel.subdomain')
    });
    logger.info({ url: tunnel.url }, 'Connected local tunnel');
    isReconnecting = false;
  } catch (e) {
    reconnect(
      logger,
      `Local tunnel got an exception, try to connect after ${
        retryMs / 1000
      } secs.`,
      10000
    );
    return null;
  }

  // Get config for local tunnel url
  const cachedLocalTunnelURL = await cache.hget(
    'trailing-trade-common',
    'local-tunnel-url'
  );

  // If new url is different, then notify slack
  if (cachedLocalTunnelURL !== tunnel.url) {
    // Save config with local tunnel url
    await cache.hset('trailing-trade-common', 'local-tunnel-url', tunnel.url);

    slack.sendMessage(`*Public URL:* ${tunnel.url}`);
    logger.info(
      { localTunnelURL: tunnel.url },
      'New URL detected, sent to Slack.'
    );
  }

  if (tunnel.url.includes(config.get('localTunnel.subdomain')) === true) {
    // If new url is configured subdomain, then reset retry.
    retryMs = 60 * 60 * 1000;
  } else {
    // If new url is not configured subdomain, then retry to connect later
    reconnect(
      logger,
      `Local tunnel is different with configured subdomain. Try after ${
        retryMs / 1000
      } secs.`,
      retryMs
    );
  }

  tunnel.on('error', () => {
    // tunnels are closed
    reconnect(
      logger,
      `Local tunnel got an error, try to connect after ${retryMs / 1000} secs.`,
      retryMs
    );
  });

  tunnel.on('close', () => {
    reconnect(
      logger,
      `Local tunnel closed, try to connect after ${retryMs / 1000} secs.`,
      retryMs
    );
  });

  return tunnel;
};

/**
 * Configure the local tunnel
 *
 * @param {*} serverLogger
 * @returns
 */
const configureLocalTunnel = async serverLogger => {
  const logger = serverLogger.child({ server: 'local-tunnel' });

  return connect(logger);
};

module.exports = { configureLocalTunnel };
