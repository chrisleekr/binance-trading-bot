const config = require('config');
const { PubSub, cache } = require('../../../helpers');

const handlePassword = async (logger, ws, payload) => {
  logger.info({ payload }, 'Start password verify');

  const { data: typedPassword } = payload;

  const retrievedPassword = config.get('password');

  if (retrievedPassword === typedPassword.pass) {
    typedPassword.config.botOptions.login.logged = true;
    typedPassword.config.botOptions.login.elapsedTime = new Date();
    await cache.set(
      `tempLogin`,
      JSON.stringify(typedPassword.config.botOptions.login),
      typedPassword.config.botOptions.login.loginWindowMinutes * 60
    );

    PubSub.publish('frontend-notification', {
      type: 'success',
      title: `Unlocking bot.`
    });
    ws.send(JSON.stringify({ result: true, type: 'login-success' }));
  }
};

module.exports = { handlePassword };
