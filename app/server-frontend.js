const express = require('express');
const basicAuth = require('express-basic-auth');
const otp = require('node-2fa');
const path = require('path');
const config = require('config');
const fs = require('fs');

const { configureWebSocket } = require('./websocket/configure');
const { configureLocalTunnel } = require('./local-tunnel/configure');

let SECRET_2FA = false;
if (fs.existsSync('./.2fa_secret')) {
  SECRET_2FA = fs.readFileSync('./.2fa_secret', { encoding: 'utf8' });
}

const basicAuthChallenge = (username, password) => {
  if (!config.frontendAuth.enabled) {
    return true;
  }

  const usernameOk = basicAuth.safeCompare(
    username,
    config.frontendAuth.username
  );

  let passwordOk = false;
  if (config.frontendAuth.mode2fa && SECRET_2FA) {
    const passwordPlain = basicAuth.safeCompare(
      password.slice(0, -6),
      config.frontendAuth.password
    );
    const password2fa = Boolean(
      otp.verifyToken(
        SECRET_2FA,
        password.replace(config.frontendAuth.password, '')
      )
    );

    passwordOk = passwordPlain && password2fa;
  } else {
    passwordOk = basicAuth.safeCompare(password, config.frontendAuth.password);
  }

  return usernameOk && passwordOk;
};

const runFrontend = async serverLogger => {
  const logger = serverLogger.child({ server: 'frontend' });
  logger.info({ config }, `API ${config.get('mode')} frontend started on`);

  const app = express();
  if (config.frontendAuth.enabled) {
    const baOptions = {
      authorizer: basicAuthChallenge,
      challenge: true,
      realm: 'Binance Trading Bot'
    };
    if (config.frontendAuth.mode2fa) {
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
