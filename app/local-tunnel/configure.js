const localtunnel = require('localtunnel');
const config = require('config');
const { slack, cache } = require('../helpers');

const connect = async logger => {
  if (config.get('localTunnel.enabled') !== true) {
    logger.info('Local tunnel is disabled');
    await cache.hdel('trailing-trade-common', 'local-tunnel-url');
    return false;
  }

  logger.info('Attempt connecting local tunnel');
  const tunnel = await localtunnel({
    port: 80,
    subdomain: config.get('localTunnel.subdomain')
  });

  logger.info({ url: tunnel.url }, 'Connected local tunnel');

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

  tunnel.on('close', () => {
    // tunnels are closed
    logger.warn('local tunnel closed, try to connect after 5 secs');
    setTimeout(() => connect(logger), 5000);
  });

  return tunnel;
};

const configureLocalTunnel = async serverLogger => {
  const logger = serverLogger.child({ server: 'local-tunnel' });

  return connect(logger);
};

module.exports = { configureLocalTunnel };
