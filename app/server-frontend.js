const express = require('express');
const basicAuth = require('express-basic-auth');
const otp = require('node-2fa');
const path = require('path');
const config = require('config');
const fs = require('fs');

const { configureWebSocket } = require('./websocket/configure');
const { configureLocalTunnel } = require('./local-tunnel/configure');

let OTP_SECRET = false;
if (fs.existsSync('./.2fa_secret')) {
  OTP_SECRET = fs.readFileSync('./.2fa_secret', { encoding: 'utf8' });
}

const basicAuthChallenge = (username, password) => {
  if (!config.frontend_auth) {
    return true;
  }

  const usernameOk = basicAuth.safeCompare(
    username,
    config.frontend_auth.username
  );

  let passwordOk = false;
  if (config.frontend_auth.mode_otp && OTP_SECRET) {
    const passwordPlain = basicAuth.safeCompare(password.slice(0, -6), config.frontend_auth.password);
    const password2fa = Boolean(otp.verifyToken(OTP_SECRET, password.replace(config.frontend_auth.password, '')))

    passwordOk = passwordPlain && password2fa;
  } else {
    passwordOk = basicAuth.safeCompare(password, config.frontend_auth.password);
  }

  return usernameOk & passwordOk;
};

const runFrontend = async serverLogger => {
  const logger = serverLogger.child({ server: 'frontend' });
  logger.info({ config }, `API ${config.get('mode')} frontend started on`);

  const app = express();
  if (config.frontend_auth) {
    const baOptions = {
      authorizer: basicAuthChallenge,
      challenge: true,
      realm: 'Binance Trading Bot'
    };
    if (config.frontend_auth.mode_otp) {
      baOptions.realm += ' - 2FA';
    }

    app.use(basicAuth(baOptions));
  }
  app.use(express.static(path.join(__dirname, '/../public')));

  const server = app.listen(80);

  await configureWebSocket(server, logger);
  await configureLocalTunnel(logger);
};

module.exports = { runFrontend };
