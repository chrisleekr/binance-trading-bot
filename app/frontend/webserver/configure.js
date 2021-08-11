const { v4: uuidv4 } = require('uuid');

const { cache } = require('../../helpers');

const {
  handleAuth,
  handleGridTradeArchiveGetBySymbol,
  handleGridTradeArchiveGetByQuoteAsset,
  handleGridTradeArchiveDelete,
  handle404
} = require('./handlers');

const configureJWTToken = async () => {
  let jwtSecret = await cache.get('auth-jwt-secret');

  if (jwtSecret === null) {
    jwtSecret = uuidv4();
    await cache.set('auth-jwt-secret', jwtSecret);
  }

  return jwtSecret;
};

const configureWebServer = async (app, funcLogger) => {
  const logger = funcLogger.child({ server: 'webserver' });

  // Firstly get(or set) JWT secret
  await configureJWTToken();

  handleAuth(logger, app);
  handleGridTradeArchiveGetBySymbol(logger, app);
  handleGridTradeArchiveGetByQuoteAsset(logger, app);
  handleGridTradeArchiveDelete(logger, app);
  handle404(logger, app);
};

module.exports = { configureWebServer };
