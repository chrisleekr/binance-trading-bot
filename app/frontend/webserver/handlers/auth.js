const _ = require('lodash');
const bcrypt = require('bcryptjs');
const config = require('config');
const moment = require('moment-timezone');
const jwt = require('jsonwebtoken');
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

    const configuredPassword = config.get('authentication.password');

    logger.info(
      {
        configuredPassword,
        requestedPassword,
        verifyPassword: verifyPassword(configuredPassword, requestedPassword)
      },
      'handle authentication'
    );

    if (verifyPassword(configuredPassword, requestedPassword) === false) {
      PubSub.publish('frontend-notification', {
        type: 'error',
        title: 'Sorry, please enter correct password.'
      });

      slack.sendMessage(
        `Binance Webserver (${moment().format(
          'HH:mm:ss.SSS'
        )}):\nThe bot failed to authenticate.\n` +
          `- Entered password: ${requestedPassword}`
      );

      return res.send({
        success: false,
        status: 401,
        message: 'Unautorised',
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
      `Binance Webserver (${moment().format(
        'HH:mm:ss.SSS'
      )}):\nThe bot succeeded to authenticate.`
    );

    return res.send({
      success: true,
      status: 200,
      message: 'Autorised',
      data: {
        authToken
      }
    });
  });
};

module.exports = { handleAuth };
