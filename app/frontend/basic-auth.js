const basicAuth = require('express-basic-auth');
const otp = require('node-2fa');
const fs = require('fs');
const config = require('config');

const basicAuthChallenge = (usernamePlain, passwordPlain) => {
  const {
    frontend: {
      auth: {
        twoFAEnabled: auth2FAEnabled,
        username: authUsername,
        password: authPassword
      }
    }
  } = config;

  let SECRET_2FA = false;
  if (fs.existsSync(`${__dirname}/../../.2fa_secret`)) {
    SECRET_2FA = fs.readFileSync(`${__dirname}/../../.2fa_secret`, {
      encoding: 'utf8'
    });
  }

  const validUsername = basicAuth.safeCompare(usernamePlain, authUsername);

  let validPassword = false;
  if (auth2FAEnabled && SECRET_2FA) {
    const validPasswordPlain = basicAuth.safeCompare(
      passwordPlain.slice(0, -6),
      config.frontend.auth.password
    );

    const validPassword2FA = Boolean(
      otp.verifyToken(SECRET_2FA, passwordPlain.replace(authPassword, ''))
    );

    validPassword = validPasswordPlain && validPassword2FA;
  } else {
    validPassword = basicAuth.safeCompare(
      passwordPlain,
      config.frontend.auth.password
    );
  }

  return validUsername && validPassword;
};

const setBasicAuth = (app, funcLogger) => {
  const logger = funcLogger.child({ func: 'basic-auth' });

  const {
    frontend: {
      auth: { enabled: authEnabled, twoFAEnabled: auth2FAEnabled }
    }
  } = config;

  if (authEnabled) {
    logger.info(
      { authEnabled, auth2FAEnabled },
      'Authentication is enabled. Configure basic authentication.'
    );

    const basicAuthOptions = {
      authorizer: basicAuthChallenge,
      challenge: true,
      realm: 'Binance Trading Bot'
    };
    if (auth2FAEnabled) {
      logger.info('2FA authentication is enabled. Add 2FA option.');
      basicAuthOptions.realm += ' - 2FA';
    }

    app.use(basicAuth(basicAuthOptions));
  }
};

module.exports = { setBasicAuth };
