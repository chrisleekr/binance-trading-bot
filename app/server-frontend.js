const compression = require('compression');
const express = require('express');
const cors = require('cors');
const path = require('path');
const config = require('config');
const requestIp = require('request-ip');
const { RateLimiterRedis } = require('rate-limiter-flexible');

const { cache } = require('./helpers');

const maxConsecutiveFails = config.get(
  'authentication.loginLimiter.maxConsecutiveFails'
);

const loginLimiter = new RateLimiterRedis({
  redis: cache.redis,
  keyPrefix: 'login',
  points: maxConsecutiveFails,
  duration: config.get('authentication.loginLimiter.duration'),
  blockDuration: config.get('authentication.loginLimiter.blockDuration')
});

const { configureWebServer } = require('./frontend/webserver/configure');
const { configureWebSocket } = require('./frontend/websocket/configure');
const { configureLocalTunnel } = require('./frontend/local-tunnel/configure');

const runFrontend = async serverLogger => {
  const logger = serverLogger.child({ server: 'frontend' });
  logger.info({ config }, `API ${config.get('mode')} frontend started on`);

  const app = express();
  app.use(compression());
  app.use(cors());
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  app.use(express.static(path.join(__dirname, '/../public')));

  const server = app.listen(80);

  if (config.get('authentication.enabled')) {
    const rateLimiterMiddleware = async (req, res, next) => {
      const clientIp = requestIp.getClientIp(req);

      const rateLimiterLogin = await loginLimiter.get(clientIp);

      if (rateLimiterLogin.remainingPoints <= 0) {
        res
          .status(403)
          .send(
            `You are blocked until ${new Date(
              Date.now() + rateLimiterLogin.msBeforeNext
            )}.`
          );
      } else {
        next();
      }
    };

    app.use(rateLimiterMiddleware);
  }

  await configureWebServer(app, logger, { loginLimiter });
  await configureWebSocket(server, logger, { loginLimiter });
  await configureLocalTunnel(logger);
};

module.exports = { runFrontend };
