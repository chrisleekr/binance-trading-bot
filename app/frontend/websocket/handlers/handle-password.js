
const { PubSub, cache } = require('../../../helpers');
const config = require('config');
const { getGlobalConfiguration } = require('../../../cronjob/trailingTradeHelper/configuration');

const verifyPassword = async (savedPassword, typedPassword) => {
  let verifiedLength = 0;

  //Verifies char by char if the password is equal.
  try {
    for (let indexToVerify = 0; indexToVerify < savedPassword.length; indexToVerify++) {
      if (typedPassword.length > indexToVerify) {
        if (savedPassword[indexToVerify] === typedPassword[indexToVerify]) {
          verifiedLength++;
        }
      }
    }
  } finally {
    if (verifiedLength === savedPassword.length) {
      return true;
    } else {
      return false;
    }
  }
}

const handlePassword = async (logger, ws, payload) => {
  logger.info({ payload }, 'Start password verify');

  const { data: newConfiguration } = payload;

  const { typedPassword } = newConfiguration;
  const retrievedPassword = Array.from(config.get('password'));

  if (await verifyPassword(retrievedPassword, typedPassword.pass)) {
    typedPassword.config.botOptions.login.logged = true;
    typedPassword.config.botOptions.login.elapsedTime = new Date();
    await cache.set(`tempLogin`, JSON.stringify(typedPassword.config.botOptions.login), (typedPassword.config.botOptions.login.loginWindowMinutes * 60));

    PubSub.publish('frontend-notification', {
      type: 'success',
      title: `Unlocking bot. ${JSON.stringify(typedPassword.config)}`
    });
    ws.send(JSON.stringify({ result: true, type: 'login-success' }));
  }

};

module.exports = { handlePassword };
