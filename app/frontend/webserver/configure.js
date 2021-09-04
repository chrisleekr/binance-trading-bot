const { v4: uuidv4 } = require('uuid');

const { cache } = require('../../helpers');

const { setHandlers } = require('./handlers');

const configureJWTToken = async () => {
  let jwtSecret = await cache.get('auth-jwt-secret');

  if (jwtSecret === null) {
    jwtSecret = uuidv4();
    await cache.set('auth-jwt-secret', jwtSecret);
  }

  return jwtSecret;
};

const configureWebServer = async (app, funcLogger, { loginLimiter }) => {
  const logger = funcLogger.child({ server: 'webserver' });

  // Firstly get(or set) JWT secret
  await configureJWTToken();

  await setHandlers(logger, app, { loginLimiter });
};

module.exports = { configureWebServer };
