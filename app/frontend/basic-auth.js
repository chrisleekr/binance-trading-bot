const basicAuth = require('express-basic-auth');
const otp = require('node-2fa');
const fs = require('fs');
const config = require('config');

const basicAuthChallenge = (plainUsername, plainPassword) => {
  const auth2FAEnabled = config.get('frontend.auth.twoFAEnabled');
  const authUsername = config.get('frontend.auth.username');
  const authPassword = config.get('frontend.auth.password');

  let SECRET_2FA = false;
  if (fs.existsSync(`${__dirname}/../../.2fa_secret`)) {
    SECRET_2FA = fs.readFileSync(`${__dirname}/../../.2fa_secret`, {
      encoding: 'utf8'
    });
  }

  const validUsername = basicAuth.safeCompare(plainUsername, authUsername);

  let validPassword = false;
  if (auth2FAEnabled && SECRET_2FA) {
    const validPlainPassword = basicAuth.safeCompare(
      plainPassword.slice(0, -6), // Remove last 6 digits for OTP code
      authPassword
    );

    const validPassword2FA =
      otp.verifyToken(SECRET_2FA, plainPassword.replace(authPassword, '')) !==
      null;
    validPassword = validPlainPassword && validPassword2FA;
  } else {
    validPassword = basicAuth.safeCompare(plainPassword, authPassword);
  }

  return validUsername && validPassword;
};

const setBasicAuth = (app, funcLogger) => {
  const logger = funcLogger.child({ func: 'basic-auth' });

  const authEnabled = config.get('frontend.auth.enabled');
  const auth2FAEnabled = config.get('frontend.auth.twoFAEnabled');

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
