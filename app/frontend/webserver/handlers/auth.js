const _ = require('lodash');
const bcrypt = require('bcryptjs');
const config = require('config');
const moment = require('moment-timezone');
const jwt = require('jsonwebtoken');
const requestIp = require('request-ip');
const {
  getGlobalConfiguration
} = require('../../../cronjob/trailingTradeHelper/configuration');
const { cache, PubSub, slack } = require('../../../helpers');

const verifyPassword = (configuredPassword, requestedPassword) => {
  let result = false;
  try {
    result = bcrypt.compareSync(
      requestedPassword,
      bcrypt.hashSync(configuredPassword)
    );
    // eslint-disable-next-line no-empty
  } catch (_e) {}
  return result;
};

const generateToken = async logger => {
  const jwtSecret = await cache.get('auth-jwt-secret');

  const globalConfiguration = await getGlobalConfiguration(logger);

  const expiresIn =
    _.get(globalConfiguration, ['botOptions', 'authentication', 'lockAfter']) *
    60;

  return jwt.sign(
    {
      authenticatedAt: moment()
    },
    jwtSecret,
    {
      algorithm: 'HS256',
      expiresIn
    }
  );
};

const handleAuth = async (funcLogger, app) => {
  const logger = funcLogger.child({ endpoint: '/auth' });

  app.route('/auth').post(async (req, res) => {
    const { password: requestedPassword } = req.body;
    const clientIp = requestIp.getClientIp(req);

    const configuredPassword = config.get('authentication.password');

    const checkPasswordSuccess = verifyPassword(
      configuredPassword,
      requestedPassword
    );

    logger.info(
      {
        input: requestedPassword,
        success: checkPasswordSuccess,
        clientIp
      },
      'handle authentication'
    );

    if (!checkPasswordSuccess) {
      PubSub.publish('frontend-notification', {
        type: 'error',
        title: 'Sorry, please enter correct password.'
      });

      slack.sendMessage(
        `${config.get('appName')} Webserver (${moment().format(
          'HH:mm:ss'
        )}):\n❌ The bot failed to authenticate.\n` +
          `- Entered password: ${requestedPassword}\n` +
          `- IP: ${clientIp}`
      );

      return res.send({
        success: false,
        status: 401,
        message: 'Unauthorized',
        data: {
          authToken: ''
        }
      });
    }

    const authToken = await generateToken(logger);

    PubSub.publish('frontend-notification', {
      type: 'success',
      title: 'You are authenticated.'
    });

    slack.sendMessage(
      `${config.get('appName')} Webserver (${moment().format(
        'HH:mm:ss'
      )}):\n✅ The bot succeeded to authenticate.\n- IP: ${clientIp}`
    );

    return res.send({
      success: true,
      status: 200,
      message: 'Authorized',
      data: {
        authToken
      }
    });
  });
};

module.exports = { handleAuth };
